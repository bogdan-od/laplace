export interface Reply<T> {
  json: T;
  /** `name=value` of a cookie the server set, to send back. */
  cookie: string | null;
}

/** A minimal JSON client for the demo seeding; a non-2xx answer throws with the response text. */
export class ApiClient {
  constructor(private readonly base: string) {}

  async call<T>(
    method: string,
    path: string,
    body?: unknown,
    cookie?: string,
  ): Promise<Reply<T>> {
    const response = await fetch(this.base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `${method} ${path} -> ${response.status} ${text.slice(0, 300)}`,
      );
    }
    const set = response.headers.get('set-cookie');
    return {
      json: (text ? JSON.parse(text) : null) as T,
      cookie: set ? (set.split(';')[0] ?? null) : null,
    };
  }
}
