// A 9p image file failed to load during replay (no network or no answer): the replay stops with a message
// naming the file, not with a hash "divergence". Needs a profile with 9p (alpine); the driver replaces the loader.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const DRIVER = fileURLToPath(new URL("./engine.node.mjs", import.meta.url));
const BOOT_SNAP = fileURLToPath(new URL("../../images/alpine-boot.snap", import.meta.url));
const TIMEOUT_MS = 300000;

async function driver(...args) {
    try {
        const { stdout } = await run("node", [DRIVER, ...args], { timeout: TIMEOUT_MS });
        return JSON.parse(stdout.trim().split("\n").at(-1));
    } catch(error) {
        if(!error.stdout) throw error;
        return JSON.parse(error.stdout.trim().split("\n").at(-1));
    }
}

test("an image file load failure during replay names the file, not the state hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-image-"));
    try {
        const journal = join(dir, "alpine.json");
        const recorded = await driver("record", "alpine", journal, BOOT_SNAP);
        assert.equal(recorded.ok, true, JSON.stringify(recorded));
        for(const how of ["throw", "hang"]) {
            const result = await driver("image_failure", journal, BOOT_SNAP, how);
            assert.equal(result.ok, true, `${how}: ${JSON.stringify(result)}`);
        }
        // A rejected tracked promise must not stay unhandled: in Node 22 that would end the process with a raw error.
        const { stdout } = await run("node", [DRIVER, "image_failure", journal, BOOT_SNAP, "throw"], { timeout: TIMEOUT_MS, env: { ...process.env, KEEP_ALIVE_AFTER_ERROR: "1" } }).catch(error => error);
        assert.match(stdout, /не вдалося завантажити файл образу/);
        assert.doesNotMatch(stdout, /UNHANDLED/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("live mode: while an image file is read, the core sends status with waiting at least once a second", async () => {
    const result = await driver("image_wait", "alpine", BOOT_SNAP, "4500");
    assert.equal(result.ok, true, JSON.stringify(result));
});
