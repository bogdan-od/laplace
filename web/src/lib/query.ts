// TanStack Query glue: a query key is the API route plus its parameters,
// so "invalidate everything about classes" is a prefix match on the route.

import { QueryClient, queryOptions } from "@tanstack/react-query";
import type { Api, ApiRoute } from "@shared/api";
import { api, ApiFailure, NetworkFailure, type ApiArgs } from "./api";

const MAX_NETWORK_RETRIES = 2;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // A refusal (4xx) is the answer and does not change on a repeat; only a lost connection is retried.
      retry: (count, error) => error instanceof NetworkFailure && count < MAX_NETWORK_RETRIES,
    },
  },
});

interface KeyOptions {
  params?: unknown;
  query?: unknown;
}

export function queryKey(route: ApiRoute, options?: KeyOptions): readonly [ApiRoute, unknown, unknown] {
  return [route, options?.params ?? null, options?.query ?? null];
}

export function apiQuery<K extends ApiRoute>(route: K, ...args: ApiArgs<K>) {
  // ApiOptions<K> always has the params/query shape KeyOptions describes.
  const options = args[0] as KeyOptions | undefined;
  return queryOptions({
    queryKey: queryKey(route, options),
    queryFn: (): Promise<Api[K]["res"]> => api(route, ...args),
  });
}

/** Marks every cached answer of the route stale (any parameters) and refetches the mounted ones. */
export function invalidateRoute(route: ApiRoute): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: [route] });
}

export const ME_KEY = queryKey("GET /api/me");

export function meQuery() {
  return queryOptions({
    queryKey: ME_KEY,
    // Who am I: a 401 here is the normal answer for a visitor, not a reason to redirect.
    queryFn: async () => {
      try {
        return await api("GET /api/me", { redirectOn401: false });
      } catch (error) {
        if (error instanceof ApiFailure && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

/** After login, logout or a 401: forget everything that belonged to the previous user. */
export function resetSession(me: Api["GET /api/me"]["res"] | null): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "GET /api/me" });
  queryClient.setQueryData(ME_KEY, me);
}
