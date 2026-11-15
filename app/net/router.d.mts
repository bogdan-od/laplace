export interface RouterMachine {
    on(name: "net_out", fn: (frame: Uint8Array) => void): void;
    net_in(frame: Uint8Array): void;
}

export interface RouterMesh {
    send_all(frame: Uint8Array): void;
    knows_destination(frame: Uint8Array): boolean;
    send_known(frame: Uint8Array): void;
}

export interface RouterRelay {
    readonly is_open: boolean;
    send(frame: Uint8Array): void;
}

/** The only `net_out` subscriber of a machine: decides whether a frame goes to room neighbours, the relay, or both. */
export class Router {
    #private;
    constructor(machine: RouterMachine);
    attach_mesh(mesh: RouterMesh): void;
    attach_relay(relay: RouterRelay): void;
    /** Frames from the relay also pass here, so the router learns which addresses are behind it. */
    from_relay(frame: Uint8Array): void;
}
