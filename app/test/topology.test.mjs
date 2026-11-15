import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate_topology, build_topology, fill_setup } from "../net/topology.mjs";

const SAMPLE_URL = new URL("../topologies/router-on-a-stick.json", import.meta.url);
const BROADCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const ETHERTYPE_OFFSET = 12;

const sample = () => JSON.parse(readFileSync(SAMPLE_URL, "utf8"));
const mac = last => [0x02, 0, 0, 0, 0, last];

function frame(dst, src) {
    const bytes = new Uint8Array(20);
    bytes.set(dst, 0);
    bytes.set(src, 6);
    bytes[ETHERTYPE_OFFSET] = 0x08;
    return bytes;
}

const tag_of = bytes => (bytes[ETHERTYPE_OFFSET] === 0x81 && bytes[ETHERTYPE_OFFSET + 1] === 0x00)
    ? ((bytes[ETHERTYPE_OFFSET + 2] << 8) | bytes[ETHERTYPE_OFFSET + 3]) & 0x0fff : null;

class FakeMachine {
    received = [];
    #handlers = [];
    net_in(bytes) { this.received.push(bytes); }
    on(name, fn) { if(name === "net_out") this.#handlers.push(fn); }
    emit(bytes) { this.#handlers.forEach(fn => fn(bytes)); }
}

const build = (desc, extra = {}) => build_topology(desc, { create_machine: () => new FakeMachine(), ...extra });

function mutated(change) {
    const desc = sample();
    change(desc);
    return validate_topology(desc);
}

function expect_error(errors, fragment) {
    assert.ok(errors.some(error => error.includes(fragment)), `expected an error with "${fragment}", got: ${JSON.stringify(errors)}`);
}

const machine_desc = (id, extra = {}) => ({ id, profile: "buildroot", ...extra });
const access = (machine, sw, vlan) => ({ machine, switch: sw, mode: "access", vlan });
const trunk_link = (a, b, allowed = [10, 20]) => ({ switch: a, to: b, mode: "trunk", allowed });

function two_switches() {
    return {
        format: "v86-topology/1",
        machines: ["a", "b", "c", "d"].map(id => machine_desc(id)),
        switches: [{ id: "sw1" }, { id: "sw2" }],
        links: [access("a", "sw1", 10), access("b", "sw1", 20), access("c", "sw2", 10), access("d", "sw2", 20), trunk_link("sw1", "sw2")],
    };
}

test("the router-on-a-stick sample passes the check without errors", () => {
    assert.deepEqual(validate_topology(sample()), []);
});

test("a sample with two switches and a trunk passes the check", () => {
    assert.deepEqual(validate_topology(two_switches()), []);
});

test("error: garbage input does not crash the check", () => {
    for(const junk of [null, undefined, 5, "text", [], {}, { format: "v86-topology/1" }]) {
        assert.ok(validate_topology(junk).length > 0);
    }
});

test("error: unknown format", () => {
    expect_error(mutated(desc => { desc.format = "v86-topology/2"; }), "формат");
});

test("error: repeated machine id", () => {
    expect_error(mutated(desc => { desc.machines[2].id = "pc1"; }), '"pc1"');
});

test("error: a switch id equals a machine id", () => {
    expect_error(mutated(desc => { desc.switches[0].id = "r1"; }), '"r1"');
});

test("error: unknown profile", () => {
    expect_error(mutated(desc => { desc.machines[0].profile = "windows"; }), 'профіль "windows"');
});

test("a machine without a link in a large topology passes the check", () => {
    assert.deepEqual(mutated(desc => { desc.links.pop(); }), []);
});

test("a lone machine without switches and links passes the check", () => {
    const single = { format: "v86-topology/1", machines: [machine_desc("m")], switches: [], links: [] };
    assert.deepEqual(validate_topology(single), []);
});

test("error: a machine has two links", () => {
    const errors = mutated(desc => { desc.links.push(access("pc1", "sw1", 10)); });
    expect_error(errors, 'Машина "pc1": має бути не більше одного');
});

test("error: a link to a missing machine", () => {
    expect_error(mutated(desc => { desc.links.push(access("ghost", "sw1", 10)); }), 'машина "ghost"');
});

test("error: a link to a missing switch", () => {
    expect_error(mutated(desc => { desc.links[0].switch = "sw9"; }), 'комутатор "sw9"');
});

test("error: to points to a missing switch", () => {
    expect_error(mutated(desc => { desc.links.push(trunk_link("sw1", "sw9")); }), 'комутатор "sw9"');
});

test("error: VLAN outside 1..4094", () => {
    expect_error(mutated(desc => { desc.links[0].vlan = 0; }), 'машини "pc1"');
    expect_error(mutated(desc => { desc.links[0].vlan = 4095; }), 'машини "pc1"');
});

test("error: VLAN is not an integer", () => {
    expect_error(mutated(desc => { desc.links[0].vlan = 10.5; }), "VLAN");
    expect_error(mutated(desc => { desc.links[0].vlan = "10"; }), "VLAN");
});

test("error: unknown port mode", () => {
    expect_error(mutated(desc => { desc.links[0].mode = "hybrid"; }), "режим");
});

test("error: trunk without allowed", () => {
    expect_error(mutated(desc => { delete desc.links[1].allowed; }), "allowed");
});

test("error: trunk with an empty allowed", () => {
    expect_error(mutated(desc => { desc.links[1].allowed = []; }), "allowed");
});

test("error: a bad VLAN in allowed", () => {
    expect_error(mutated(desc => { desc.links[1].allowed = [10, 5000]; }), "5000");
});

test("error: native is not in allowed", () => {
    expect_error(mutated(desc => { desc.links[1].native = 30; }), "native");
});

test("native from allowed is accepted", () => {
    assert.deepEqual(mutated(desc => { desc.links[1].native = 10; }), []);
});

test("error: two uplinks", () => {
    const uplink = { uplink: "relay", switch: "sw1", mode: "access", vlan: 30 };
    expect_error(mutated(desc => { desc.links.push(uplink, { ...uplink }); }), "uplink");
});

test("one uplink is accepted", () => {
    const uplink = { uplink: "relay", switch: "sw1", mode: "access", vlan: 30 };
    assert.deepEqual(mutated(desc => { desc.links.push(uplink); }), []);
});

test("error: unknown uplink", () => {
    const uplink = { uplink: "modem", switch: "sw1", mode: "access", vlan: 30 };
    expect_error(mutated(desc => { desc.links.push(uplink); }), "uplink");
});

test("error: no machines at all", () => {
    const errors = validate_topology({ format: "v86-topology/1", machines: [], switches: [{ id: "sw1" }], links: [] });
    expect_error(errors, "Кількість машин");
});

test("error: more than six machines", () => {
    const desc = {
        format: "v86-topology/1",
        machines: Array.from({ length: 7 }, (_, i) => machine_desc(`m${i}`)),
        switches: [{ id: "sw1" }],
        links: Array.from({ length: 7 }, (_, i) => access(`m${i}`, "sw1", 10)),
    };
    expect_error(validate_topology(desc), "Кількість машин");
});

test("error: no machines array", () => {
    const desc = sample();
    delete desc.machines;
    expect_error(validate_topology(desc), "machines");
});

test("error: a loop of three switches", () => {
    const desc = two_switches();
    desc.switches.push({ id: "sw3" });
    desc.links.push(trunk_link("sw2", "sw3"), trunk_link("sw3", "sw1"));
    expect_error(validate_topology(desc), "цикл");
});

test("error: a switch linked to itself", () => {
    const desc = two_switches();
    desc.links.push(trunk_link("sw1", "sw1"));
    expect_error(validate_topology(desc), "цикл");
});

test("error: a double link between a pair of switches", () => {
    const desc = two_switches();
    desc.links.push(trunk_link("sw2", "sw1"));
    expect_error(validate_topology(desc), "цикл");
});

test("error: not a trunk between switches", () => {
    const desc = two_switches();
    desc.links[4] = { switch: "sw1", to: "sw2", mode: "access", vlan: 10 };
    expect_error(validate_topology(desc), "trunk");
});

test("the sample file is read and has profiles and settings", () => {
    const desc = sample();
    assert.deepEqual(desc.machines.map(machine => machine.id), ["pc1", "r1", "srv"]);
    assert.ok(desc.machines.every(machine => machine.setup.includes("{mac}")));
});

test("fill_setup replaces every {mac}", () => {
    assert.equal(fill_setup("a {mac} b {mac}\n", "02:00:00:00:00:07"), "a 02:00:00:00:00:07 b 02:00:00:00:00:07\n");
    assert.equal(fill_setup("no substitution", "x"), "no substitution");
    assert.equal(fill_setup("{mac}", "$&"), "$&");
});

test("build: a frame from pc1 reaches r1 with tag 10 and does not reach srv", () => {
    const net = build(sample());
    const [pc1, r1, srv] = ["pc1", "r1", "srv"].map(id => net.machines.get(id));
    pc1.emit(frame(BROADCAST, mac(1)));
    assert.equal(r1.received.length, 1);
    assert.equal(tag_of(r1.received[0]), 10);
    assert.equal(srv.received.length, 0);
    assert.equal(pc1.received.length, 0);
});

test("build: a frame from srv goes to r1 with tag 20", () => {
    const net = build(sample());
    const [pc1, r1, srv] = ["pc1", "r1", "srv"].map(id => net.machines.get(id));
    srv.emit(frame(BROADCAST, mac(3)));
    assert.equal(r1.received.length, 1);
    assert.equal(tag_of(r1.received[0]), 20);
    assert.equal(pc1.received.length, 0);
});

test("build: r1's reply with tag 10 goes to pc1 untagged", () => {
    const net = build(sample());
    const [pc1, r1, srv] = ["pc1", "r1", "srv"].map(id => net.machines.get(id));
    pc1.emit(frame(BROADCAST, mac(1)));
    const tagged = new Uint8Array([...frame(mac(1), mac(2)).subarray(0, 12), 0x81, 0x00, 0x00, 0x0a, 0x08, 0x00, 0, 0, 0, 0]);
    r1.emit(tagged);
    assert.equal(pc1.received.length, 1);
    assert.equal(tag_of(pc1.received[0]), null);
    assert.equal(srv.received.length, 0);
});

test("build: two switches, VLAN 10 passes the trunk, VLAN 20 stays local", () => {
    const net = build(two_switches());
    const [a, b, c, d] = ["a", "b", "c", "d"].map(id => net.machines.get(id));
    a.emit(frame(BROADCAST, mac(1)));
    assert.equal(c.received.length, 1);
    assert.equal(tag_of(c.received[0]), null);
    assert.equal(d.received.length, 0);
    assert.equal(b.received.length, 0);
    d.emit(frame(BROADCAST, mac(4)));
    assert.equal(b.received.length, 1);
    assert.equal(c.received.length, 1);
    assert.equal(a.received.length, 0);
});

test("build: two switches, a VLAN outside allowed does not pass the trunk", () => {
    const desc = two_switches();
    desc.links[4] = trunk_link("sw1", "sw2", [20]);
    const net = build(desc);
    net.machines.get("a").emit(frame(BROADCAST, mac(1)));
    assert.equal(net.machines.get("c").received.length, 0);
});

test("build: a loop of three switches is rejected by the check", () => {
    const desc = two_switches();
    desc.switches.push({ id: "sw3" });
    desc.links.push(trunk_link("sw2", "sw3"), trunk_link("sw3", "sw1"));
    assert.ok(validate_topology(desc).length > 0);
});

test("build: an uplink without a relay is skipped, with a relay it works both ways", () => {
    const desc = sample();
    desc.links.push({ uplink: "relay", switch: "sw1", mode: "access", vlan: 10 });
    assert.equal(validate_topology(desc).length, 0);
    assert.equal(build(desc).ports.length, 3);

    const sent = [];
    const relay = { send: bytes => sent.push(bytes), on_frame: null };
    const net = build(desc, { relay });
    assert.equal(net.ports.length, 4);
    net.machines.get("pc1").emit(frame(BROADCAST, mac(1)));
    assert.equal(sent.length, 1);
    relay.on_frame(frame(mac(1), mac(9)));
    assert.equal(net.machines.get("pc1").received.length, 1);
    net.teardown();
    assert.equal(relay.on_frame, null);
});

test("teardown: after teardown frames do not arrive", () => {
    const net = build(sample());
    const [pc1, r1] = ["pc1", "r1"].map(id => net.machines.get(id));
    pc1.emit(frame(BROADCAST, mac(1)));
    assert.equal(r1.received.length, 1);
    net.teardown();
    assert.equal(net.ports.length, 0);
    assert.doesNotThrow(() => pc1.emit(frame(BROADCAST, mac(1))));
    assert.equal(r1.received.length, 1);
});

test("build_topology: a machine without a link does not create a port", () => {
    const single = { format: "v86-topology/1", machines: [machine_desc("m")], switches: [], links: [] };
    const net = build(single);
    assert.equal(net.machines.size, 1);
    assert.equal(net.ports.length, 0);
    assert.doesNotThrow(() => net.teardown());
});

test("teardown: calls off if it exists and can be called twice", () => {
    const offs = [];
    class WithOff extends FakeMachine {
        off(name, fn) { offs.push([name, fn]); }
    }
    const net = build_topology(sample(), { create_machine: () => new WithOff() });
    net.teardown();
    net.teardown();
    assert.equal(offs.length, 3);
    assert.ok(offs.every(([name]) => name === "net_out"));
});
