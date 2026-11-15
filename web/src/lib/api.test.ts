import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiFailure, configureApi, describeError, fetchBlob, loginAddress, NetworkFailure, safeNext } from "./api";

const fetchMock = vi.fn<typeof fetch>();
const onUnauthorized = vi.fn<(address: string) => void>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  configureApi({ currentAddress: () => "/classes/3?a=7", onUnauthorized });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  onUnauthorized.mockReset();
});

describe("api()", () => {
  it("returns the parsed body and fills path params and query", async () => {
    fetchMock.mockResolvedValue(json([{ id: 5 }]));
    const result = await api("GET /api/classes/:id/activity", { params: { id: 3 }, query: { before: 9 } });
    expect(result).toEqual([{ id: 5 }]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/classes/3/activity?before=9");
    expect(init?.method).toBe("GET");
  });

  it("encodes path params and sends a JSON body with the method from the route", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ id: 1, login: "a", name: "A", role: "teacher" }, 201)));
    await api("POST /api/invites/:code/accept", { params: { code: "A B/C" } });
    await api("POST /api/auth/login", { body: { login: "x", password: "y" } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/invites/A%20B%2FC/accept");
    const init = fetchMock.mock.calls[1]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"login":"x","password":"y"}');
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  });

  it("gives null for an empty successful body", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    expect(await api("POST /api/auth/logout")).toBeNull();
  });

  it("turns a 4xx into ApiFailure with the server message, status and code", async () => {
    fetchMock.mockResolvedValue(json({ statusCode: 409, message: "Цей логін зайнято", code: "login_taken" }, 409));
    const failure = await api("GET /api/me").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure).not.toBeInstanceOf(NetworkFailure);
    if (!(failure instanceof ApiFailure)) throw new Error("not an ApiFailure");
    expect(failure.status).toBe(409);
    expect(failure.code).toBe("login_taken");
    expect(failure.message).toBe("Цей логін зайнято");
    expect(describeError(failure)).toBe("Цей логін зайнято");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("keeps the whole error body, so a chunk_gap carries event_count", async () => {
    fetchMock.mockResolvedValue(json({ statusCode: 409, message: "gap", code: "chunk_gap", event_count: 12 }, 409));
    const failure = await api("GET /api/me").catch((error: unknown) => error);
    expect(failure instanceof ApiFailure && failure.data?.["event_count"]).toBe(12);
  });

  it("uses a generic text for a non-JSON error body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 }));
    const failure = await api("GET /api/me").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(describeError(failure)).toBe("Помилка сервера. Спробуйте пізніше.");
  });

  it("turns a rejected fetch into NetworkFailure with its own text", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const failure = await api("GET /api/me").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NetworkFailure);
    expect(failure).not.toBeInstanceOf(ApiFailure);
    expect(describeError(failure)).toContain("Немає зв'язку");
  });

  it("lets an aborted request through unchanged", async () => {
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const failure = await api("GET /api/me").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DOMException);
  });

  it("sends the user to /login?next=<current address> on 401 and still throws", async () => {
    fetchMock.mockResolvedValue(json({ statusCode: 401, message: "Потрібно увійти", code: "not_logged_in" }, 401));
    const failure = await api("GET /api/classes").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith("/login?next=%2Fclasses%2F3%3Fa%3D7");
  });

  it("does not redirect on 401 when the caller expects it", async () => {
    fetchMock.mockResolvedValue(json({ statusCode: 401, message: "Неправильний логін або пароль" }, 401));
    await api("POST /api/auth/login", { body: { login: "x", password: "y" }, redirectOn401: false }).catch(() => null);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("passes keepalive and the abort signal to fetch", async () => {
    fetchMock.mockResolvedValue(json({ event_count: 4 }));
    const controller = new AbortController();
    await api("PUT /api/branches/:id/events", {
      params: { id: 2 },
      body: { from: 0, events: [] },
      keepalive: true,
      signal: controller.signal,
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.keepalive).toBe(true);
    expect(init?.signal).toBe(controller.signal);
  });
});

describe("fetchBlob()", () => {
  it("returns the bytes of a non-JSON route and shares the error mapping", async () => {
    fetchMock.mockResolvedValueOnce(new Response("name;grade\nA;5\n", { status: 200 }));
    const blob = await fetchBlob("GET /api/classes/:id/grades.csv", { params: { id: 3 } });
    expect(await blob.text()).toBe("name;grade\nA;5\n");

    fetchMock.mockResolvedValueOnce(json({ statusCode: 403, message: "Заборонено" }, 403));
    const failure = await fetchBlob("GET /api/calendar.ics").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiFailure);
  });
});

describe("login redirect helpers", () => {
  it("builds the login address", () => {
    expect(loginAddress("/")).toBe("/login?next=%2F");
  });

  it("accepts only paths inside the site as next", () => {
    expect(safeNext("/classes/3?a=1")).toBe("/classes/3?a=1");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("https://evil.example/")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
  });
});
