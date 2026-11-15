// The only way the frontend talks to the server over HTTP. Types come from the contract (`Api`).
// Two failure classes: ApiFailure (the server answered with an error status) and NetworkFailure
// (no answer at all). They need different texts and different retry rules, so they never mix.

import type { Api, ApiError, ApiErrorCode, ApiRoute } from "@shared/api";

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | undefined;
  /** The parsed response body when it was JSON (carries e.g. event_count of a chunk_gap), else null. */
  readonly data: Record<string, unknown> | null;

  constructor(status: number, message: string, code: ApiErrorCode | undefined, data: Record<string, unknown> | null) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export class NetworkFailure extends Error {
  constructor(options?: ErrorOptions) {
    super("Немає зв'язку із сервером", options);
    this.name = "NetworkFailure";
  }
}

export const NETWORK_TEXT = "Немає зв'язку із сервером. Перевірте мережу й спробуйте ще раз.";
const SERVER_TEXT = "Помилка сервера. Спробуйте пізніше.";
const UNKNOWN_TEXT = "Щось пішло не так. Спробуйте ще раз.";

/** Text for a person; the server already writes its messages in Ukrainian. */
export function describeError(error: unknown): string {
  if (error instanceof NetworkFailure) return NETWORK_TEXT;
  if (error instanceof ApiFailure) return error.message;
  return UNKNOWN_TEXT;
}

type PathParams<S extends string> = S extends `${string}:${infer P}/${infer Rest}`
  ? P | PathParams<`/${Rest}`>
  : S extends `${string}:${infer P}`
    ? P
    : never;

type ParamsOption<K extends string> = [PathParams<K>] extends [never]
  ? unknown
  : { params: Record<PathParams<K>, string | number> };
type BodyOption<K extends ApiRoute> = Api[K]["body"] extends undefined ? unknown : { body: Api[K]["body"] };
type QueryOption<K extends ApiRoute> = Api[K]["query"] extends undefined
  ? unknown
  : object extends Api[K]["query"]
    ? { query?: Api[K]["query"] }
    : { query: Api[K]["query"] };

export interface RequestFlags {
  signal?: AbortSignal;
  /** fetch keepalive, for the request sent on pagehide. */
  keepalive?: boolean;
  /**
   * A 401 is an expected answer (login form, the "who am I" probe): do not send the user to /login.
   * Default true.
   */
  redirectOn401?: boolean;
}

export type ApiOptions<K extends ApiRoute> = ParamsOption<K> & BodyOption<K> & QueryOption<K> & RequestFlags;
export type ApiArgs<K extends ApiRoute> = object extends ApiOptions<K> ? [options?: ApiOptions<K>] : [options: ApiOptions<K>];

interface Environment {
  /** Address of the page now, used for `next` after a 401. */
  currentAddress(): string;
  onUnauthorized(loginAddress: string): void;
}

const environment: Environment = {
  currentAddress: () => `${globalThis.location.pathname}${globalThis.location.search}`,
  onUnauthorized: (loginAddress) => globalThis.location.assign(loginAddress),
};

/** The app replaces the defaults (a full page load) with router navigation; tests replace both. */
export function configureApi(overrides: Partial<Environment>): void {
  Object.assign(environment, overrides);
}

export function loginAddress(current: string): string {
  return `/login?next=${encodeURIComponent(current)}`;
}

/** Only a path inside this site is a valid `next`; anything else would be an open redirect. */
export function safeNext(next: string | null): string {
  if (next === null || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

interface RawOptions extends RequestFlags {
  params?: Record<string, string | number>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

const PARAM_RE = /:([A-Za-z]+)/g;

function buildUrl(path: string, params: RawOptions["params"], query: RawOptions["query"]): string {
  const filled = path.replace(PARAM_RE, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`Missing path parameter ${name} for ${path}`);
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `${filled}?${text}` : filled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiError(value: Record<string, unknown>): value is Record<string, unknown> & ApiError {
  return typeof value["statusCode"] === "number" && typeof value["message"] === "string";
}

async function failureFrom(response: Response): Promise<ApiFailure> {
  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (isRecord(parsed) && isApiError(parsed)) {
    return new ApiFailure(response.status, parsed.message, parsed.code, parsed);
  }
  const message = response.status >= 500 ? SERVER_TEXT : UNKNOWN_TEXT;
  return new ApiFailure(response.status, message, undefined, isRecord(parsed) ? parsed : null);
}

async function request(route: string, options: RawOptions): Promise<Response> {
  const space = route.indexOf(" ");
  const method = route.slice(0, space);
  const url = buildUrl(route.slice(space + 1), options.params, options.query);
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers, credentials: "same-origin" };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  if (options.signal) init.signal = options.signal;
  if (options.keepalive) init.keepalive = true;

  let response: Response;
  try {
    response = await globalThis.fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new NetworkFailure({ cause: error });
  }
  if (response.ok) return response;

  const failure = await failureFrom(response);
  if (failure.status === 401 && options.redirectOn401 !== false) {
    environment.onUnauthorized(loginAddress(environment.currentAddress()));
  }
  throw failure;
}

function rawOptions(args: [options?: object]): RawOptions {
  // The conditional ApiOptions type guarantees the shape; here it is read back as a plain record.
  return (args[0] ?? {}) as RawOptions;
}

/**
 * JSON call. Success with an empty body (logout, deletes) gives null, which is what `Api` declares
 * for such routes. The cast below is the trust boundary: the contract is the only check of the
 * response shape, as for every typed client.
 */
export async function api<K extends ApiRoute>(route: K, ...args: ApiArgs<K>): Promise<Api[K]["res"]> {
  const response = await request(route, rawOptions(args));
  const text = await response.text().catch((error: unknown) => {
    throw new NetworkFailure({ cause: error });
  });
  if (text === "") return null as Api[K]["res"];
  return JSON.parse(text) as Api[K]["res"];
}

/** Body that is not JSON for the app (grades.csv, calendar.ics, journals as a stream): bytes as they came. */
export async function fetchBlob<K extends ApiRoute>(route: K, ...args: ApiArgs<K>): Promise<Blob> {
  const response = await request(route, rawOptions(args));
  try {
    return await response.blob();
  } catch (error) {
    throw new NetworkFailure({ cause: error });
  }
}

/** Downloads a non-JSON route and offers the file to the user. */
export async function download<K extends ApiRoute>(route: K, filename: string, ...args: ApiArgs<K>): Promise<void> {
  const blob = await fetchBlob(route, ...args);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
