import type { PortConfig } from "./topology.mjs";

export interface SwitchPort {
    readonly id: number;
    /** Feed a frame arriving from the device on this port. */
    receive(frame: Uint8Array): void;
}

/** Switch with VLANs. The MAC table is keyed by (VLAN, MAC), capped at 1024 entries with a full clear. */
export class Switch {
    #private;
    /** Without `options` the port is an access port in VLAN 1. Throws `RangeError` on a bad VLAN or trunk. */
    add_port(send: (frame: Uint8Array) => void, options?: PortConfig): SwitchPort;
    remove_port(port: SwitchPort): void;
}
