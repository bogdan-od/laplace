/** Relay URL or `null`. Sources by priority: the `relay` page parameter (`off` disables), then app/config.json. Throws on a bad address. */
export function read_relay_url(params: URLSearchParams): Promise<string | null>;
