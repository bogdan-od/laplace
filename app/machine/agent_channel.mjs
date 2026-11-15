// System channel: requests to the agent in the guest (ttyS1).
//   request:  @req <id> <base64 command>\n
//   response: @res <id> <return code> <base64 output>\n   (output up to 64 KiB)
// Lines on ttyS1 that are not a response to our request (the student may write to /dev/ttyS1 too) are ignored.
const RES_PREFIX = "@res ";
const BUFFER_MAX = 1 << 20;
const ID_RADIX = 36;
const ID_RANDOM_CHARS = 6;
// While the emulator stands still (waiting for a JIT module to compile: ten seconds or more under load), the guest
// cannot answer, and those seconds do not count toward the timeout. `stalled` is polled rather than evented: the
// waiting happens in another thread.
const STALL_POLL_MS = 250;
const STALL_GRANT_MAX_MS = 120000;

export const encode_request = (id, command) => `@req ${id} ${btoa(String.fromCharCode(...new TextEncoder().encode(command)))}\n`;

// null if the line is not a response or is corrupted.
export function parse_response(line) {
    if(!line.startsWith(RES_PREFIX)) return null;
    const [id, rc, payload = ""] = line.slice(RES_PREFIX.length).trim().split(" ");
    if(!id || !/^\d+$/.test(rc)) return null;
    try {
        const bytes = Uint8Array.from(atob(payload), ch => ch.charCodeAt(0));
        return { id, rc: Number(rc), output: new TextDecoder().decode(bytes) };
    }
    catch { return null; }
}

export class AgentChannel {
    #waiters = new Map();
    #buffer = "";
    #seq = 0;
    #send;
    #stalled;

    // send(text) writes text to the guest's ttyS1; stalled() tells whether the emulator stands still and cannot run the
    // guest.
    constructor(send, { stalled = () => false } = {}) { this.#send = send; this.#stalled = stalled; }

    request(command, timeout_ms) {
        const id = `${Math.random().toString(ID_RADIX).slice(2, 2 + ID_RANDOM_CHARS)}${++this.#seq}`;
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null, poller: null, stalled_ms: 0, granted_ms: 0 };
            const expire = () => {
                // Seconds of stall not yet added to the deadline (the poll may not have counted them before the timer
                // fired).
                const extra = Math.min(waiter.stalled_ms, STALL_GRANT_MAX_MS) - waiter.granted_ms;
                if(extra > 0) {
                    waiter.granted_ms += extra;
                    waiter.timer = setTimeout(expire, extra);
                    return;
                }
                clearInterval(waiter.poller);
                this.#waiters.delete(id);
                reject(new Error(`Агент не відповів на системну команду за ${timeout_ms / 1000} с (можливо, його зупинено)`));
            };
            waiter.poller = setInterval(() => { if(this.#stalled()) waiter.stalled_ms += STALL_POLL_MS; }, STALL_POLL_MS);
            waiter.timer = setTimeout(expire, timeout_ms);
            this.#waiters.set(id, waiter);
            this.#send(encode_request(id, command));
        });
    }

    feed(bytes) {
        this.#buffer += String.fromCharCode(...bytes);
        const lines = this.#buffer.split("\n");
        this.#buffer = lines.pop();
        if(this.#buffer.length > BUFFER_MAX) this.#buffer = "";
        for(const line of lines) this.#settle(line);
    }

    #settle(line) {
        const response = parse_response(line);
        const waiter = response && this.#waiters.get(response.id);
        if(!waiter) return;
        this.#waiters.delete(response.id);
        clearTimeout(waiter.timer);
        clearInterval(waiter.poller);
        waiter.resolve({ rc: response.rc, output: response.output });
    }

    reject_all(error) {
        for(const { reject, timer, poller } of this.#waiters.values()) { clearTimeout(timer); clearInterval(poller); reject(error); }
        this.#waiters.clear();
        this.#buffer = "";
    }
}
