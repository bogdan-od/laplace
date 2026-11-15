import { mac_key } from "./frame.mjs";

const GROUP_BIT = 1;
const MAX_MAC_TABLE = 1024;

// The only net_out subscriber of a machine: decides where a frame goes (room neighbours and/or the relay).
// Frames from the relay pass here too (from_relay): this is how the Router learns which addresses are behind it.
export class Router {
    #machine;
    #mesh = null;
    #relay = null;
    #behind_relay = new Set();

    constructor(machine) {
        this.#machine = machine;
        machine.on("net_out", frame => this.#route(frame));
    }

    attach_mesh(mesh) {
        this.#mesh = mesh;
    }

    attach_relay(relay) {
        this.#relay = relay;
    }

    from_relay(frame) {
        const key = mac_key(frame, 6);
        if(!this.#behind_relay.has(key) && this.#behind_relay.size >= MAX_MAC_TABLE) this.#behind_relay.clear();
        this.#behind_relay.add(key);
        this.#machine.net_in(frame);
    }

    // The order of checks matters: a public relay switches between its clients itself and returns frames of room
    // neighbours, so a neighbour's address is looked up in the mesh first and only then in the relay table.
    #route(frame) {
        const relay = this.#relay?.is_open ? this.#relay : null;
        if(frame[0] & GROUP_BIT) {
            this.#mesh?.send_all(frame);
            relay?.send(frame);
        } else if(this.#mesh?.knows_destination(frame)) {
            this.#mesh.send_known(frame);
        } else if(relay && this.#behind_relay.has(mac_key(frame, 0))) {
            relay.send(frame);
        } else {
            // Unknown destination (the MAC table was cleared): like a switch, flood to everyone, the relay included.
            this.#mesh?.send_all(frame);
            relay?.send(frame);
        }
    }
}
