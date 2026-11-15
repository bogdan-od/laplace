import { frame_ok } from "./frame.mjs";

const MAC_LEN = 6;
const SRC_OFFSET = MAC_LEN;
const ETHERTYPE_OFFSET = 12;
const ETH_HEADER_LEN = 14;
const TAG_LEN = 4;
const TAGGED_HEADER_LEN = ETH_HEADER_LEN + TAG_LEN;
const TPID_HI = 0x81;
const TPID_LO = 0x00;
const VLAN_ID_MASK = 0x0fff;
const VLAN_MIN = 1;
const VLAN_MAX = 4094;
const DEFAULT_VLAN = 1;
const MAX_TABLE = 1024;

export class Switch {
    #ports = new Map();
    #table = new Map();
    #next_id = 1;

    // Without the second argument the port is an access port in VLAN 1.
    add_port(send, options = { mode: "access", vlan: DEFAULT_VLAN }) {
        const config = normalize_port(options);
        const port = { id: this.#next_id++, receive: frame => this.#on_frame(port, frame) };
        this.#ports.set(port, { send, ...config });
        return port;
    }

    remove_port(port) {
        this.#ports.delete(port);
        for(const [key, owner] of this.#table) {
            if(owner === port) this.#table.delete(key);
        }
    }

    #on_frame(port, frame) {
        const config = this.#ports.get(port);
        if(config === undefined || !frame_ok(frame)) return;
        const vlan_frame = this.#classify(config, frame);
        if(vlan_frame === null) return;
        const { vlan, plain, tagged } = vlan_frame;
        this.#learn(table_key(vlan, frame, SRC_OFFSET), port);
        if(frame[0] & 1) return this.#flood(port, vlan_frame);
        const known = this.#table.get(table_key(vlan, frame, 0));
        if(known === undefined) return this.#flood(port, vlan_frame);
        if(known !== port) this.#deliver(this.#ports.get(known), vlan_frame);
    }

    // Returns the frame's VLAN and its two forms (untagged and tagged), which
    // are built lazily; null means the frame must be dropped.
    #classify(config, frame) {
        const has_tag = frame[ETHERTYPE_OFFSET] === TPID_HI && frame[ETHERTYPE_OFFSET + 1] === TPID_LO;
        if(has_tag && frame.length < TAGGED_HEADER_LEN) return null;
        if(config.mode === "access") {
            if(has_tag) return null;
            return make_views(config.vlan, frame, null);
        }
        if(!has_tag) {
            if(config.native === null) return null;
            return make_views(config.native, frame, null);
        }
        const vlan = ((frame[ETHERTYPE_OFFSET + 2] << 8) | frame[ETHERTYPE_OFFSET + 3]) & VLAN_ID_MASK;
        if(!config.allowed.has(vlan)) return null;
        return make_views(vlan, null, frame);
    }

    #learn(key, port) {
        if(!this.#table.has(key) && this.#table.size >= MAX_TABLE) this.#table.clear();
        this.#table.set(key, port);
    }

    #flood(from, vlan_frame) {
        for(const [port, config] of this.#ports) {
            if(port !== from && carries(config, vlan_frame.vlan)) this.#deliver(config, vlan_frame);
        }
    }

    #deliver(config, vlan_frame) {
        const { vlan } = vlan_frame;
        const as_tagged = config.mode === "trunk" && vlan !== config.native;
        config.send(as_tagged ? vlan_frame.tagged() : vlan_frame.plain());
    }
}

function normalize_port(options) {
    if(options.mode === "access") {
        check_vlan(options.vlan);
        return { mode: "access", vlan: options.vlan };
    }
    if(options.mode !== "trunk") throw new RangeError(`unknown port mode: ${options.mode}`);
    const allowed = options.allowed;
    if(!Array.isArray(allowed) || allowed.length === 0) throw new RangeError("trunk without an allowed list");
    allowed.forEach(check_vlan);
    const native = options.native ?? null;
    if(native !== null && !allowed.includes(native)) throw new RangeError(`native ${native} is not in allowed`);
    return { mode: "trunk", allowed: new Set(allowed), native };
}

function check_vlan(vlan) {
    if(!Number.isInteger(vlan) || vlan < VLAN_MIN || vlan > VLAN_MAX) {
        throw new RangeError(`VLAN out of range ${VLAN_MIN}..${VLAN_MAX}: ${vlan}`);
    }
}

function carries(config, vlan) {
    return config.mode === "access" ? config.vlan === vlan : config.allowed.has(vlan);
}

// The input array is never modified: adding or removing a tag makes a new copy.
function make_views(vlan, plain_source, tagged_source) {
    let plain = plain_source;
    let tagged = tagged_source;
    return {
        vlan,
        plain: () => plain ??= strip_tag(tagged),
        tagged: () => tagged ??= insert_tag(plain, vlan),
    };
}

function insert_tag(frame, vlan) {
    const out = new Uint8Array(frame.length + TAG_LEN);
    out.set(frame.subarray(0, ETHERTYPE_OFFSET), 0);
    out[ETHERTYPE_OFFSET] = TPID_HI;
    out[ETHERTYPE_OFFSET + 1] = TPID_LO;
    out[ETHERTYPE_OFFSET + 2] = vlan >> 8;
    out[ETHERTYPE_OFFSET + 3] = vlan & 0xff;
    out.set(frame.subarray(ETHERTYPE_OFFSET), ETHERTYPE_OFFSET + TAG_LEN);
    return out;
}

function strip_tag(frame) {
    const out = new Uint8Array(frame.length - TAG_LEN);
    out.set(frame.subarray(0, ETHERTYPE_OFFSET), 0);
    out.set(frame.subarray(ETHERTYPE_OFFSET + TAG_LEN), ETHERTYPE_OFFSET);
    return out;
}

function table_key(vlan, frame, offset) {
    const mac = Array.from(frame.subarray(offset, offset + MAC_LEN), byte => byte.toString(16).padStart(2, "0")).join(":");
    return `${vlan}/${mac}`;
}
