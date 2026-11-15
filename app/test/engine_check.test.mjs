// The core's check() waits for the recorded event: the journal ends with the check both when the guest is busy and when
// the machine
// was paused; such a journal replays without divergence; a check cannot be recorded in replay mode.
// One machine per process, so every step is a separate run of the engine.node.mjs driver.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { check_journal_strict } from "../core/journal.mjs";

const run = promisify(execFile);
const DRIVER = fileURLToPath(new URL("./engine.node.mjs", import.meta.url));
const BOOT_SNAP = fileURLToPath(new URL("../../images/buildroot-boot.snap", import.meta.url));
const TIMEOUT_MS = 120000;

async function driver(...args) {
    const { stdout } = await run("node", [DRIVER, ...args], { timeout: TIMEOUT_MS });
    return JSON.parse(stdout.trim().split("\n").at(-1));
}

test("the journal ends with a check while the guest is busy and while paused, replay without divergence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-check-"));
    try {
        const journal = join(dir, "check.json");
        const recorded = await driver("check", "buildroot", journal, BOOT_SNAP);
        assert.equal(recorded.ok, true, JSON.stringify(recorded));
        assert.ok(recorded.checks >= 4);
        assert.doesNotThrow(() => check_journal_strict(JSON.parse(readFileSync(journal, "utf8"))));
        const replayed = await driver("replay", journal, BOOT_SNAP);
        assert.equal(replayed.ok, true, JSON.stringify(replayed));
        assert.equal(replayed.checks, recorded.checks);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("in replay mode check() is rejected with a clear message", async () => {
    const result = await driver("check_replay", "buildroot");
    assert.equal(result.ok, true, JSON.stringify(result));
});
