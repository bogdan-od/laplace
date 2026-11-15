// Router on a fake machine, mesh and relay: a unicast frame to an address known to be behind the relay
// goes only there and does not reach the neighbours' journals. No browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../net/router.mjs";

const GATEWAY = [0x52, 0x54, 0x00, 0x12, 0x35, 0x02];
const OWN = [0x02, 0x00, 0x00, 0x00, 0x00, 0x07];
const BROADCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const PADDING = 20;

const frame_of = (to, from) => Uint8Array.from([...to, ...from, 0x08, 0x00, ...new Array(PADDING).fill(0)]);

function setup({ relay_open = true } = {}) {
    const calls = [];
    const net_in = [];
    let net_out;
    const machine = { on: (name, fn) => { net_out = fn; }, net_in: frame => net_in.push(frame) };
    const known = new Set();
    const mesh = {
        knows_destination: frame => known.has(Array.from(frame.subarray(0, 6)).join(":")),
        send_known: () => calls.push("mesh:known"),
        send_all: () => calls.push("mesh:all"),
    };
    const relay = { is_open: relay_open, send: () => calls.push("relay") };
    const router = new Router(machine);
    router.attach_mesh(mesh);
    router.attach_relay(relay);
    return { router, calls, net_in, relay, send: frame => net_out(frame), known: mac => known.add(mac.join(":")) };
}

test("an address known behind the relay: the frame goes only to the relay, neighbours do not see it", () => {
    const { router, calls, send } = setup();
    router.from_relay(frame_of(OWN, GATEWAY));
    send(frame_of(GATEWAY, OWN));
    assert.deepEqual(calls, ["relay"]);
});

test("a completely unknown destination goes to everyone: neighbours and the relay", () => {
    const { calls, send } = setup();
    send(frame_of(GATEWAY, OWN));
    assert.deepEqual(calls, ["mesh:all", "relay"]);
});

test("a neighbour known to the mesh table gets the frame alone, even if the relay also showed its address", () => {
    const { router, calls, send, known } = setup();
    router.from_relay(frame_of(OWN, GATEWAY));
    known(GATEWAY);
    send(frame_of(GATEWAY, OWN));
    assert.deepEqual(calls, ["mesh:known"]);
});

test("relay closed: its table is not used, the frame goes as unknown", () => {
    const { router, calls, send, relay } = setup();
    router.from_relay(frame_of(OWN, GATEWAY));
    relay.is_open = false;
    send(frame_of(GATEWAY, OWN));
    assert.deepEqual(calls, ["mesh:all"]);
});

test("a broadcast frame goes to neighbours and the relay", () => {
    const { calls, send } = setup();
    send(frame_of(BROADCAST, OWN));
    assert.deepEqual(calls, ["mesh:all", "relay"]);
});

test("a frame from the relay reaches the machine", () => {
    const { router, net_in } = setup();
    const frame = frame_of(OWN, GATEWAY);
    router.from_relay(frame);
    assert.deepEqual(net_in, [frame]);
});

test("the relay address table is bounded: it is cleared after overflow", () => {
    const { router, calls, send } = setup();
    router.from_relay(frame_of(OWN, GATEWAY));
    for(let i = 0; i < 1024; i++) router.from_relay(frame_of(OWN, [0x02, 0, 0, 0, i >> 8, i & 0xff]));
    send(frame_of(GATEWAY, OWN));
    assert.deepEqual(calls, ["mesh:all", "relay"]);
});
