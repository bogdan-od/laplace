const FIRST_MS = 500;
const MAX_MS = 10000;
const JITTER = 0.2;

// How long to wait for a WebSocket to open before closing it and reconnecting. A handshake over a bad
// link takes a few seconds (Linux SYN retries at 1, 3 and 7 s still fit), and without a limit a hung
// socket waits for the OS timeout, that is, minutes. Equal to the cap of the pause between attempts, so that waiting
// for one
// attempt never exceeds the pause the backoff reaches after a few failures anyway.
export const CONNECT_TIMEOUT_MS = MAX_MS;

// Pause between reconnect attempts: doubles up to MAX_MS, with jitter so that a whole class does not knock on the
// server at once.
export class Backoff {
    #delay = FIRST_MS;

    next() {
        const delay = this.#delay;
        this.#delay = Math.min(delay * 2, MAX_MS);
        return delay * (1 - JITTER + 2 * JITTER * Math.random());
    }

    reset() {
        this.#delay = FIRST_MS;
    }
}
