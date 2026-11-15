import type { Room } from "./room.mjs";

export interface MeshMachine {
    net_in(frame: Uint8Array): void;
}

/**
 * Links between students: one RTCPeerConnection per neighbour, the offer is made by the side with the smaller
 * number. Until the channel opens or after it fails, frames go through the server. Dispatches `change`.
 */
export class Mesh extends EventTarget {
    #private;
    constructor(room: Room, machine: MeshMachine);
    /** Neighbours that can be reached now. */
    get peer_count(): number;
    /** Neighbours that are reached through the server. */
    get server_count(): number;
    knows_destination(frame: Uint8Array): boolean;
    send_known(frame: Uint8Array): void;
    send_all(frame: Uint8Array): void;
    /** Closes every RTCPeerConnection and stops the timers; later room messages are ignored. Idempotent. */
    close(): void;
}
