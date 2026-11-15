// v86det changes to the 9p state saving without which a snapshot taken in the middle of the Alpine boot did not
// restore:
// qid.type of an inode survives a snapshot, and a hole in the fids array stays a hole. The state passes through JSON,
// as in v86det/src/state.js: objects with get_state are replaced by its result.
import assert from "node:assert/strict";
import { test } from "node:test";
import "../core/v86_release.mjs";
import { FS } from "../../v86det/lib/filesystem.js";
import { Virtio9p } from "../../v86det/lib/9p.js";
import { MemoryFileStorage } from "../../v86det/src/browser/filestorage.js";

const through_json = state => JSON.parse(JSON.stringify(state, (key, value) =>
    key !== "" && value && typeof value.get_state === "function" ? value.get_state() : value));

test("qid.type of a file from the image description (0) does not change after set_state", () => {
    const fs = new FS(new MemoryFileStorage());
    const id = fs.CreateFile("from-image", 0);
    // This is what an inode loaded from the image description looks like: nobody set the type in its qid.
    fs.inodes[id].qid.type = 0;
    const restored = new FS(new MemoryFileStorage());
    restored.set_state(through_json(fs.get_state()));
    assert.equal(restored.inodes[id].qid.type, 0);
});

test("a snapshot without qid.type (old format) restores with the type derived from mode, as before", () => {
    const fs = new FS(new MemoryFileStorage());
    const id = fs.CreateFile("old", 0);
    const state = through_json(fs.get_state());
    state[0][id].length = 14;
    const restored = new FS(new MemoryFileStorage());
    restored.set_state(state);
    assert.equal(restored.inodes[id].qid.type, 0x80);
});

test("a hole in the 9p fids survives a snapshot and does not break the next snapshot", () => {
    const fids = [];
    fids[0] = { inodeid: 0, type: 1, uid: 0, dbg_name: "" };
    fids[2] = { inodeid: 5, type: 1, uid: 0, dbg_name: "etc" };
    const saved = through_json(Virtio9p.prototype.get_state.call({ fids, virtio: {}, fs: {} }));
    assert.equal(saved[8][1], null);
    const target = { virtio: { set_state() {}, queues: [{}] }, fs: { set_state() {} } };
    Virtio9p.prototype.set_state.call(target, saved);
    assert.equal(target.fids.length, 3);
    assert.equal(1 in target.fids, false);
    assert.deepEqual(target.fids[2], fids[2]);
    assert.deepEqual(through_json(Virtio9p.prototype.get_state.call(target))[8], saved[8]);
});
