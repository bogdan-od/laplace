import { Backoff, CONNECT_TIMEOUT_MS } from "./backoff.mjs";
import { frame_ok } from "./frame.mjs";

// wsproxy relay: one binary WebSocket frame is one Ethernet frame. Reconnects by itself
// after a break; frames are lost during the break (this is Ethernet, TCP in the guest resends).
export class Relay extends EventTarget {
    host;
    state = "connecting";
    settled;
    #url;
    #on_frame;
    #socket = null;
    #backoff = new Backoff();
    #settle;

    constructor(url, on_frame) {
        super();
        this.host = new URL(url).host;
        this.#url = url;
        this.#on_frame = on_frame;
        this.settled = new Promise(resolve => { this.#settle = resolve; });
        this.#open();
    }

    get is_open() {
        return this.state === "open";
    }

    send(frame) {
        if(this.is_open) this.#socket.send(frame);
    }

    #open() {
        const socket = new WebSocket(this.#url);
        this.#socket = socket;
        socket.binaryType = "arraybuffer";
        socket.onmessage = event => this.#receive(event.data);
        socket.onopen = () => { this.#backoff.reset(); this.#set("open"); this.#settle(); };
        socket.onclose = () => this.#closed(socket);
        setTimeout(() => socket.readyState === WebSocket.CONNECTING && socket.close(), CONNECT_TIMEOUT_MS);
    }

    // A text message is not a frame: new Uint8Array("1500") would give 1500 zero bytes.
    #receive(data) {
        if(!(data instanceof ArrayBuffer)) return;
        const frame = new Uint8Array(data);
        if(frame_ok(frame)) this.#on_frame(frame);
    }

    #closed(socket) {
        if(socket !== this.#socket) return;
        this.#set("closed");
        this.#settle();
        setTimeout(() => this.#open(), this.#backoff.next());
    }

    #set(state) {
        this.state = state;
        this.dispatchEvent(new Event("change"));
    }
}
