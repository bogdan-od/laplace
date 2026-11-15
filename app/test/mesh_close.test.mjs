// Mesh.close() on a stub room and a stub RTCPeerConnection: every connection is closed, timers are stopped,
// and room messages after close() open nothing new. Without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";

const connections = [];
globalThis.location ??= { search: "" };
globalThis.RTCPeerConnection ??= class {
    closed = false;
    constructor() { connections.push(this); }
    createDataChannel() { return {}; }
    async createOffer() { return { type: "offer", sdp: "x" }; }
    async setLocalDescription(description) { this.localDescription = description; }
    close() { this.closed = true; }
};
const { Mesh } = await import("../net/mesh.mjs");

function stub_room(id, peers) {
    const handlers = new Map();
    return {
        id,
        peers: new Map(peers.map(peer => [peer, { role: "student" }])),
        sent: [],
        on(type, fn) { handlers.set(type, fn); },
        emit(type, msg) { handlers.get(type)?.(msg); },
        send(msg) { this.sent.push(msg); },
    };
}

test("close() closes every connection and ignores later room messages", async () => {
    const room = stub_room("s1", ["s2", "s3"]);
    const changes = [];
    const mesh = new Mesh(room, { net_in: () => {} });
    mesh.addEventListener("change", () => changes.push(mesh.peer_count));
    assert.equal(connections.length, 2);

    mesh.close();
    assert.ok(connections.every(pc => pc.closed));
    assert.equal(mesh.peer_count, 0);

    room.emit("peer-joined", { id: "s4", role: "student" });
    room.emit("joined", {});
    assert.equal(connections.length, 2);
    mesh.send_all(new Uint8Array(14));
    assert.equal(room.sent.filter(msg => msg.type === "frame").length, 0);

    const before = changes.length;
    mesh.close();
    assert.equal(changes.length, before);
});
