/** How long to wait for a WebSocket to open before closing it and reconnecting. */
export const CONNECT_TIMEOUT_MS: number;

/** Pause between reconnect attempts: doubles up to a cap, with jitter. */
export class Backoff {
    #private;
    next(): number;
    reset(): void;
}
