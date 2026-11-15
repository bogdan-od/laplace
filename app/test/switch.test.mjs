import { test } from "node:test";
import assert from "node:assert/strict";
import { Switch } from "../net/switch.mjs";

const BROADCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const ETH_LEN = 14;
const MAX_TABLE = 1024;

const mac = last => [0x02, 0, 0, 0, 0, last];
const mac_index = i => [0x02, 0, 0, 0, i >> 8, i & 0xff];

function frame(dst, src, length = ETH_LEN) {
    const bytes = new Uint8Array(Math.max(length, 12));
    bytes.set(dst, 0);
    bytes.set(src, 6);
    return bytes.subarray(0, length);
}

function add_ports(sw, count) {
    return Array.from({ length: count }, () => {
        const got = [];
        const port = sw.add_port(item => got.push(item));
        return { port, got };
    });
}

test("broadcast goes to all ports except the incoming one", () => {
    const sw = new Switch();
    const [a, b, c] = add_ports(sw, 3);
    a.port.receive(frame(BROADCAST, mac(1)));
    assert.equal(a.got.length, 0);
    assert.equal(b.got.length, 1);
    assert.equal(c.got.length, 1);
});

test("after learning a frame goes only to the right port", () => {
    const sw = new Switch();
    const [a, b, c] = add_ports(sw, 3);
    a.port.receive(frame(BROADCAST, mac(1)));
    const to_a = frame(mac(1), mac(2));
    b.port.receive(to_a);
    assert.equal(a.got.length, 1);
    assert.equal(a.got[0], to_a);
    assert.equal(b.got.length, 1);
    c.port.receive(frame(mac(2), mac(3)));
    assert.equal(a.got.length, 1);
    assert.equal(b.got.length, 2);
    assert.equal(c.got.length, 1);
});

test("a frame to its own port is dropped", () => {
    const sw = new Switch();
    const [a, b] = add_ports(sw, 2);
    a.port.receive(frame(BROADCAST, mac(1)));
    a.port.receive(frame(mac(1), mac(3)));
    assert.equal(a.got.length, 0);
    assert.equal(b.got.length, 1);
});

test("remove_port forgets the port's MAC", () => {
    const sw = new Switch();
    const [a, b, c] = add_ports(sw, 3);
    a.port.receive(frame(BROADCAST, mac(1)));
    sw.remove_port(a.port);
    b.port.receive(frame(mac(1), mac(2)));
    assert.equal(a.got.length, 0);
    assert.equal(b.got.length, 1);
    assert.equal(c.got.length, 2);
});

test("frames shorter than 14 bytes are dropped and do not teach the table", () => {
    const sw = new Switch();
    const [a, b] = add_ports(sw, 2);
    a.port.receive(frame(BROADCAST, mac(1), ETH_LEN - 1));
    assert.equal(b.got.length, 0);
    b.port.receive(frame(mac(1), mac(2)));
    assert.equal(a.got.length, 1);
});

test("the table is cleared entirely on overflow of 1024 entries", () => {
    // The table is filled with 1024 MACs on port a. A frame from b to mac_index(0) with a full
    // table goes only to a. A new source with a full table clears it,
    // and the same frame becomes unknown, that is, it also goes to c.
    const sw = new Switch();
    const [a, b, c] = add_ports(sw, 3);
    for(let i = 0; i < MAX_TABLE; i++) a.port.receive(frame(BROADCAST, mac_index(i)));
    b.port.receive(frame(mac_index(0), mac_index(1)));
    assert.equal(a.got.length, 1);
    assert.equal(c.got.length, MAX_TABLE);
    a.port.receive(frame(BROADCAST, mac_index(MAX_TABLE)));
    b.port.receive(frame(mac_index(0), mac_index(1)));
    assert.equal(c.got.length, MAX_TABLE + 2);
    assert.equal(a.got.length, 2);
});

const TAG_LEN = 4;

function payload_frame(dst, src, payload = [1, 2, 3, 4]) {
    return Uint8Array.from([...dst, ...src, 0x08, 0x00, ...payload]);
}

function with_tag(plain, vlan) {
    return Uint8Array.from([...plain.subarray(0, 12), 0x81, 0x00, vlan >> 8, vlan & 0xff, ...plain.subarray(12)]);
}

function vlan_setup(configs) {
    const sw = new Switch();
    const ports = configs.map(options => {
        const got = [];
        const port = sw.add_port(item => got.push(item), options);
        return { port, got };
    });
    return { sw, ports };
}

const access = vlan => ({ mode: "access", vlan });
const trunk = (allowed, native = null) => ({ mode: "trunk", allowed, native });

test("two access ports of one VLAN exchange untagged frames", () => {
    const { ports: [a, b] } = vlan_setup([access(10), access(10)]);
    const hello = payload_frame(BROADCAST, mac(1));
    a.port.receive(hello);
    assert.deepEqual(b.got, [hello]);
    const reply = payload_frame(mac(1), mac(2));
    b.port.receive(reply);
    assert.deepEqual(a.got, [reply]);
});

test("ports of different VLANs are isolated, broadcast frames included", () => {
    const { ports: [a, b, c] } = vlan_setup([access(10), access(20), access(10)]);
    a.port.receive(payload_frame(BROADCAST, mac(1)));
    assert.equal(b.got.length, 0);
    assert.equal(c.got.length, 1);
    b.port.receive(payload_frame(mac(1), mac(2)));
    assert.equal(a.got.length, 0);
});

test("access -> trunk adds a tag with the right VLAN number", () => {
    const { ports: [a, t] } = vlan_setup([access(20), trunk([10, 20])]);
    const plain = payload_frame(BROADCAST, mac(1));
    a.port.receive(plain);
    assert.equal(t.got.length, 1);
    assert.deepEqual(t.got[0], with_tag(plain, 20));
    assert.equal(t.got[0].length, plain.length + TAG_LEN);
});

test("trunk -> access removes the tag and returns the original bytes", () => {
    const { ports: [t, a] } = vlan_setup([trunk([10, 20]), access(10)]);
    const plain = payload_frame(BROADCAST, mac(1), [9, 8, 7, 6, 5]);
    t.port.receive(with_tag(plain, 10));
    assert.deepEqual(a.got, [plain]);
});

test("a tagged frame on an access port is dropped", () => {
    const { ports: [a, b] } = vlan_setup([access(10), access(10)]);
    a.port.receive(with_tag(payload_frame(BROADCAST, mac(1)), 10));
    assert.equal(b.got.length, 0);
});

test("a VLAN outside allowed is dropped both ways", () => {
    const { ports: [t, a30, a10] } = vlan_setup([trunk([10, 20]), access(30), access(10)]);
    t.port.receive(with_tag(payload_frame(BROADCAST, mac(1)), 30));
    assert.equal(a30.got.length, 0);
    assert.equal(a10.got.length, 0);
    a30.port.receive(payload_frame(BROADCAST, mac(2)));
    assert.equal(t.got.length, 0);
    a10.port.receive(payload_frame(BROADCAST, mac(3)));
    assert.equal(t.got.length, 1);
});

test("native VLAN works both ways", () => {
    const { ports: [t, a] } = vlan_setup([trunk([10, 20], 10), access(10)]);
    const plain = payload_frame(BROADCAST, mac(1));
    t.port.receive(plain);
    assert.deepEqual(a.got, [plain]);
    a.port.receive(payload_frame(BROADCAST, mac(2)));
    assert.deepEqual(t.got, [payload_frame(BROADCAST, mac(2))]);
});

test("an untagged frame on a trunk without native is dropped", () => {
    const { ports: [t, a] } = vlan_setup([trunk([10]), access(10)]);
    t.port.receive(payload_frame(BROADCAST, mac(1)));
    assert.equal(a.got.length, 0);
});

test("the same MAC in two VLANs is remembered separately", () => {
    const { ports: [a10, a20, b10, b20] } = vlan_setup([access(10), access(20), access(10), access(20)]);
    a10.port.receive(payload_frame(BROADCAST, mac(1)));
    a20.port.receive(payload_frame(BROADCAST, mac(1)));
    const to_10 = payload_frame(mac(1), mac(2));
    b10.port.receive(to_10);
    assert.deepEqual(a10.got, [to_10]);
    assert.equal(a20.got.length, 0);
    const to_20 = payload_frame(mac(1), mac(3));
    b20.port.receive(to_20);
    assert.deepEqual(a20.got, [to_20]);
    assert.deepEqual(a10.got, [to_10]);
});

test("two switches over a trunk pass a frame between access ports of one VLAN", () => {
    const sw1 = new Switch();
    const sw2 = new Switch();
    const got_a = [];
    const got_b = [];
    const got_c = [];
    const a = sw1.add_port(f => got_a.push(f), access(10));
    const link1 = sw1.add_port(f => link2.receive(f), trunk([10, 20]));
    const link2 = sw2.add_port(f => link1.receive(f), trunk([10, 20]));
    const b = sw2.add_port(f => got_b.push(f), access(10));
    sw2.add_port(f => got_c.push(f), access(20));
    const hello = payload_frame(BROADCAST, mac(1));
    a.receive(hello);
    assert.deepEqual(got_b, [hello]);
    assert.equal(got_c.length, 0);
    const reply = payload_frame(mac(1), mac(2));
    b.receive(reply);
    assert.deepEqual(got_a, [reply]);
});

test("the input array did not change after all operations", () => {
    const { ports: [t, a, b, n] } = vlan_setup([trunk([10, 20], 20), access(10), access(10), access(20)]);
    const plain = payload_frame(BROADCAST, mac(1), [1, 2, 3, 4, 5, 6]);
    const tagged = with_tag(plain, 10);
    const plain_copy = plain.slice();
    const tagged_copy = tagged.slice();
    a.port.receive(plain);
    t.port.receive(tagged);
    n.port.receive(plain);
    b.port.receive(payload_frame(mac(1), mac(2)));
    assert.deepEqual(plain, plain_copy);
    assert.deepEqual(tagged, tagged_copy);
});

test("removing a port cleans the table", () => {
    const { sw, ports: [a, b, c] } = vlan_setup([access(10), access(10), access(10)]);
    a.port.receive(payload_frame(BROADCAST, mac(1)));
    sw.remove_port(a.port);
    b.port.receive(payload_frame(mac(1), mac(2)));
    assert.equal(a.got.length, 0);
    assert.equal(c.got.length, 2);
});

test("a tagged frame shorter than 18 bytes is dropped", () => {
    const { ports: [t, a] } = vlan_setup([trunk([10]), access(10)]);
    const short = with_tag(payload_frame(BROADCAST, mac(1), []), 10).subarray(0, 17);
    t.port.receive(short);
    assert.equal(a.got.length, 0);
});

test("bad port settings raise RangeError", () => {
    const sw = new Switch();
    assert.throws(() => sw.add_port(() => {}, access(0)), RangeError);
    assert.throws(() => sw.add_port(() => {}, access(4095)), RangeError);
    assert.throws(() => sw.add_port(() => {}, trunk([])), RangeError);
    assert.throws(() => sw.add_port(() => {}, trunk([10], 20)), RangeError);
    assert.throws(() => sw.add_port(() => {}, { mode: "hub" }), RangeError);
});

test("a frame to a removed port is silently dropped", () => {
    const { sw, ports: [a, b] } = vlan_setup([access(10), access(10)]);
    sw.remove_port(a.port);
    a.port.receive(payload_frame(BROADCAST, mac(1)));
    assert.equal(b.got.length, 0);
});

test("3- and 60000-byte frames do not reach the destination, 14 and 1522 do", () => {
    const sw = new Switch();
    const [a, b] = add_ports(sw, 2);
    b.port.receive(frame(BROADCAST, mac(2)));
    for(const length of [3, 60000]) {
        a.port.receive(frame(BROADCAST, mac(1), length));
        a.port.receive(frame(mac(2), mac(1), length));
    }
    assert.equal(b.got.length, 0);
    a.port.receive(frame(BROADCAST, mac(1), ETH_LEN));
    a.port.receive(frame(mac(2), mac(1), 1522));
    assert.deepEqual(b.got.map(item => item.length), [ETH_LEN, 1522]);
    a.port.receive(frame(mac(2), mac(1), 1523));
    assert.equal(b.got.length, 2);
});
