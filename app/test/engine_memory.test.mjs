// A start from a snapshot leaves no second copy of guest memory in the Worker (v86 bus handlers kept a closure holding
// the snapshot).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const DRIVER = fileURLToPath(new URL("./engine.node.mjs", import.meta.url));
const BOOT_SNAP = fileURLToPath(new URL("../../images/buildroot-boot.snap", import.meta.url));
const TIMEOUT_MS = 120000;

test("after starting from a snapshot, ArrayBuffers are smaller than 1.5 times the wasm memory size", async () => {
    let stdout;
    try { ({ stdout } = await run("node", ["--expose-gc", DRIVER, "snapshot_release", "buildroot", BOOT_SNAP], { timeout: TIMEOUT_MS })); }
    catch(error) { stdout = error.stdout; }
    const result = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(result.ok, true, JSON.stringify(result));
});
