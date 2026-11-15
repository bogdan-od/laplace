// Frames from the network (room neighbours, the relay) pass a length check before reaching the machine, the neighbours'
// MAC table
// is bounded, and the channel of a neighbour that is gone closes without an error.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { frame_ok, MAX_FRAME_LEN, MIN_FRAME_LEN } from "../net/frame.mjs";
import { to_base64 } from "../net/base64.mjs";
import { Router } from "../net/router.mjs";

const TABLE_LIMIT = 1024;

const mac = i => [0x02, 0, 0, 0, i >> 8, i & 0xff];

function frame(dst, src, length = MIN_FRAME_LEN) {
    const bytes = new Uint8Array(Math.max(length, 12));
    bytes.set(dst, 0);
    bytes.set(src, 6);
    return bytes.subarray(0, length);
}

test("frame_ok: bounds 14 and 1522 inclusive", () => {
    for(const length of [0, 3, MIN_FRAME_LEN - 1, MAX_FRAME_LEN + 1, 60000]) assert.equal(frame_ok(new Uint8Array(length)), false, `${length}`);
    for(const length of [MIN_FRAME_LEN, 60, MAX_FRAME_LEN]) assert.equal(frame_ok(new Uint8Array(length)), true, `${length}`);
});

class FakeWebSocket {
    static CONNECTING = 0;
    static instances = [];
    readyState = FakeWebSocket.CONNECTING;
    constructor(url) { this.url = url; FakeWebSocket.instances.push(this); }
    close() {}
    send() {}
}

test("Relay drops frames of the wrong length before the handler", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const saved = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket;
    try {
        const { Relay } = await import("../net/relay.mjs");
        const got = [];
        new Relay("ws://relay.test/", item => got.push(item.length));
        const socket = FakeWebSocket.instances.at(-1);
        for(const length of [3, 60000, MIN_FRAME_LEN, MAX_FRAME_LEN]) socket.onmessage({ data: new ArrayBuffer(length) });
        assert.deepEqual(got, [MIN_FRAME_LEN, MAX_FRAME_LEN]);
    } finally {
        globalThis.WebSocket = saved;
        mock.timers.reset();
    }
});

test("Relay does not turn a text message into a frame", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const saved = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket;
    try {
        const { Relay } = await import("../net/relay.mjs");
        const got = [];
        new Relay("ws://relay.test/", item => got.push(item.length));
        const socket = FakeWebSocket.instances.at(-1);
        for(const data of ["60", "-5", "abc", 100]) assert.doesNotThrow(() => socket.onmessage({ data }));
        assert.deepEqual(got, []);
    } finally {
        globalThis.WebSocket = saved;
        mock.timers.reset();
    }
});

class FakeRoom {
    id = "s1";
    peers = new Map();
    handlers = new Map();
    sent = [];
    on(type, fn) { this.handlers.set(type, fn); }
    send(message) { this.sent.push(message); }
    receive(type, message) { return this.handlers.get(type)(message); }
}

function fake_machine() {
    const got = [];
    return { got, net_in: item => got.push(item) };
}

async function mesh_over_server() {
    globalThis.location = { search: "?rtc=off" };
    const { Mesh } = await import("../net/mesh.mjs");
    const room = new FakeRoom();
    const machine = fake_machine();
    const mesh = new Mesh(room, machine);
    room.receive("peer-joined", { id: "s2", role: "student" });
    return { room, machine, mesh };
}

const from_peer_id = (room, from, bytes) => room.receive("frame", { from, data: to_base64(bytes) });
const from_peer = (room, bytes) => from_peer_id(room, "s2", bytes);

test("Mesh does not pass 3- and 60000-byte frames to the machine, passes 14 and 1522", async () => {
    const { room, machine } = await mesh_over_server();
    for(const length of [3, 60000, MIN_FRAME_LEN, MAX_FRAME_LEN]) from_peer(room, frame(mac(1), mac(2), length));
    assert.deepEqual(machine.got.map(item => item.length), [MIN_FRAME_LEN, MAX_FRAME_LEN]);
});

test("a frame of the wrong length does not teach the neighbour MAC table", async () => {
    const { room, mesh } = await mesh_over_server();
    from_peer(room, frame(mac(1), mac(2), 3));
    assert.equal(mesh.knows_destination(frame(mac(2), mac(1))), false);
    from_peer(room, frame(mac(1), mac(2)));
    assert.equal(mesh.knows_destination(frame(mac(2), mac(1))), true);
});

test("the neighbour MAC table is cleared on overflow of 1024 entries", async () => {
    const { room, mesh } = await mesh_over_server();
    for(let i = 0; i < TABLE_LIMIT; i++) from_peer(room, frame(mac(1), mac(100 + i)));
    assert.equal(mesh.knows_destination(frame(mac(100), mac(1))), true);
    from_peer(room, frame(mac(1), mac(100 + TABLE_LIMIT)));
    assert.equal(mesh.knows_destination(frame(mac(100), mac(1))), false);
    assert.equal(mesh.knows_destination(frame(mac(100 + TABLE_LIMIT), mac(1))), true);
});

class FakePeerConnection {
    static instances = [];
    localDescription = { sdp: "" };
    constructor() { FakePeerConnection.instances.push(this); }
    createDataChannel() { return this.channel = { close() {} }; }
    async createOffer() { return {}; }
    async createAnswer() { return {}; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
}

test("a channel from a neighbour whose link is already cancelled closes without error", async () => {
    globalThis.location = { search: "" };
    globalThis.RTCPeerConnection = FakePeerConnection;
    const { Mesh } = await import("../net/mesh.mjs");
    const room = new FakeRoom();
    room.peers.set("s2", { role: "student" });
    new Mesh(room, fake_machine());
    const pc = FakePeerConnection.instances.at(-1);
    room.receive("peer-left", { id: "s2" });
    let closed = false;
    assert.doesNotThrow(() => pc.ondatachannel({ channel: { close: () => { closed = true; } } }));
    assert.equal(closed, true);
});

test("neighbour DataChannel: text instead of a frame does not reach the machine, a binary frame does", async () => {
    globalThis.location = { search: "" };
    globalThis.RTCPeerConnection = FakePeerConnection;
    const { Mesh } = await import("../net/mesh.mjs");
    const room = new FakeRoom();
    room.peers.set("s2", { role: "student" });
    const machine = fake_machine();
    new Mesh(room, machine);
    const channel = FakePeerConnection.instances.at(-1).channel;
    for(const data of ["60", "-5", "abc"]) assert.doesNotThrow(() => channel.onmessage({ data }));
    channel.onmessage({ data: new ArrayBuffer(MIN_FRAME_LEN) });
    assert.deepEqual(machine.got.map(item => item.length), [MIN_FRAME_LEN]);
});

function router_over(mesh, relay) {
    const machine = { on: (name, fn) => { machine.send_out = fn; } };
    const router = new Router(machine);
    router.attach_mesh(mesh);
    if(relay) router.attach_relay(relay);
    return machine;
}

test("Router: unknown unicast destination (MAC table reset) goes to neighbours and the relay", async () => {
    const { room, mesh } = await mesh_over_server();
    const relayed = [];
    const machine = router_over(mesh, { is_open: true, send: item => relayed.push(item) });
    const out = frame(mac(2), mac(1));
    from_peer(room, frame(mac(1), mac(2)));
    machine.send_out(out);
    assert.equal(relayed.length, 0, "known destination goes only to the neighbour");
    room.sent.length = 0;
    room.receive("peer-joined", { id: "s2", role: "student" });
    assert.equal(mesh.knows_destination(out), false);
    machine.send_out(out);
    assert.deepEqual(room.sent.map(item => item.to), ["s2"]);
    assert.equal(relayed.length, 1);
});

test("Mesh: a frame after peer-left is delivered, but the link does not come back and the table is not taught", async () => {
    const { room, machine, mesh } = await mesh_over_server();
    room.receive("peer-left", { id: "s2" });
    from_peer(room, frame(mac(1), mac(2)));
    assert.equal(machine.got.length, 1);
    assert.equal(mesh.peer_count, 0);
    assert.equal(mesh.server_count, 0);
    assert.equal(mesh.knows_destination(frame(mac(2), mac(1))), false);
});

async function mesh_with_rtc(own_id) {
    globalThis.location = { search: "" };
    globalThis.RTCPeerConnection = FakePeerConnection;
    const { Mesh } = await import("../net/mesh.mjs");
    const room = new FakeRoom();
    room.id = own_id;
    const machine = fake_machine();
    return { room, machine, mesh: new Mesh(room, machine) };
}

test("Mesh: a frame from a neighbour through the server before its offer does not get in the way of the DataChannel", async () => {
    const { room, machine, mesh } = await mesh_with_rtc("s2");
    room.receive("peer-joined", { id: "s1", role: "student" });
    const before = FakePeerConnection.instances.length;
    from_peer_id(room, "s1", frame(mac(2), mac(1)));
    assert.equal(machine.got.length, 1);
    assert.equal(mesh.server_count, 0);
    await room.receive("signal", { from: "s1", data: { kind: "offer", sdp: "x" } });
    assert.equal(FakePeerConnection.instances.length, before + 1, "offer created an RTCPeerConnection");
    assert.equal(mesh.server_count, 0);
    const answer = room.sent.at(-1);
    assert.deepEqual([answer.type, answer.to, answer.data.kind], ["signal", "s1", "answer"]);
});

test("Mesh: an offer from a neighbour with only a server link left brings up the DataChannel", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const { room, mesh } = await mesh_with_rtc("s1");
        room.peers.set("s2", { role: "student" });
        room.receive("peer-joined", { id: "s2", role: "student" });
        await new Promise(resolve => setImmediate(resolve));
        mock.timers.tick(5000);
        assert.equal(mesh.server_count, 1, "DataChannel did not open within 5 s - link through the server");
        const before = FakePeerConnection.instances.length;
        await room.receive("signal", { from: "s2", data: { kind: "offer", sdp: "x" } });
        assert.equal(FakePeerConnection.instances.length, before + 1);
        assert.equal(mesh.server_count, 0);
    } finally {
        mock.timers.reset();
    }
});
