export type RelayState = "connecting" | "open" | "closed";

/** wsproxy relay: one binary WebSocket frame is one Ethernet frame. Reconnects by itself; frames are lost during a break. */
export class Relay extends EventTarget {
    #private;
    host: string;
    state: RelayState;
    /** Resolves after the first open or close. */
    settled: Promise<void>;
    constructor(url: string, on_frame: (frame: Uint8Array) => void);
    get is_open(): boolean;
    /** Does nothing while the socket is not open. */
    send(frame: Uint8Array): void;
}
