// Hash of all wasm memory in check, and an own seed for every new session. One machine per process,
// so every step is a separate run of the engine.node.mjs driver on the buildroot boot snapshot.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const DRIVER = fileURLToPath(new URL("./engine.node.mjs", import.meta.url));
const BOOT_SNAP = fileURLToPath(new URL("../../images/buildroot-boot.snap", import.meta.url));
const TIMEOUT_MS = 180000;

async function driver(...args) {
    try {
        const { stdout } = await run("node", [DRIVER, ...args], { timeout: TIMEOUT_MS });
        return JSON.parse(stdout.trim().split("\n").at(-1));
    } catch(error) {
        if(!error.stdout) throw error;
        return JSON.parse(error.stdout.trim().split("\n").at(-1));
    }
}


test("check hashes all of wasm memory: recording, replay, replay with a snapshot in the middle and restore agree, a corrupted xmm is visible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-state-"));
    try {
        const journal = join(dir, "state.json");
        const middle = join(dir, "middle.snap");
        const recorded = await driver("record", "buildroot", journal, BOOT_SNAP);
        assert.equal(recorded.ok, true, JSON.stringify(recorded));
        const checks = JSON.parse(readFileSync(journal, "utf8")).events.filter(event => event.t === "check");
        assert.ok(checks.length >= 2 && checks.every(event => /^[0-9a-f]{16}$/.test(event.m)), "check has no hash of the rest of memory");

        const plain = await driver("replay", journal, BOOT_SNAP);
        assert.equal(plain.ok, true, JSON.stringify(plain));
        const with_snapshot = await driver("replay", journal, BOOT_SNAP, "--mid", middle);
        assert.equal(with_snapshot.ok, true, JSON.stringify(with_snapshot));
        const resumed = await driver("resume", journal, middle);
        assert.equal(resumed.ok, true, JSON.stringify(resumed));

        const damaged = await driver("corrupt", journal, BOOT_SNAP);
        assert.equal(damaged.ok, true, JSON.stringify(damaged));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// /dev/urandom is read right after the session start command: without the generator reseed it is the same for the first
// 60 s
// in every session from the snapshot, and a test that read it several commands later passed only thanks to different
// timings.
test("two new sessions from one snapshot give different /dev/urandom output right after the start, each replays without divergence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-seed-"));
    try {
        const sessions = [];
        for(const name of ["first", "second"]) {
            const journal = join(dir, `${name}.json`);
            const recorded = await driver("channels", "buildroot", journal, BOOT_SNAP);
            assert.equal(recorded.ok, true, JSON.stringify(recorded));
            const replayed = await driver("replay", journal, BOOT_SNAP);
            assert.equal(replayed.ok, true, JSON.stringify(replayed));
            sessions.push({ urandom: recorded.urandom, seed: JSON.parse(readFileSync(journal, "utf8")).header.seed });
        }
        assert.ok(sessions.every(({ urandom }) => /^0000000 [0-9a-f ]+$/.test(urandom)), JSON.stringify(sessions));
        assert.notEqual(sessions[0].urandom, sessions[1].urandom);
        assert.notEqual(sessions[0].seed, sessions[1].seed);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
