// System channel (ttyS1) and teacher terminal (ttyS2) in a fresh session of every profile: the date is within ±120 s of
// the host,
// the student terminal shows nothing from the system, a system command returns its output while the student's program
// runs,
// and the student's program does not receive it; input to ttyS2 works (touch, Ctrl-C after sleep 100); a killed agent
// gives
// a timeout error; the recording replays without divergence. Every step is a separate run of the engine.node.mjs
// driver.
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
const SNAP = name => fileURLToPath(new URL(`../../images/${name}-boot.snap`, import.meta.url));
const TIMEOUT_MS = 400000;
const DATE_TOLERANCE_S = 120;

async function driver(...args) {
    try {
        const { stdout } = await run("node", [DRIVER, ...args], { timeout: TIMEOUT_MS });
        return JSON.parse(stdout.trim().split("\n").at(-1));
    } catch(error) {
        if(!error.stdout) throw error;
        return JSON.parse(error.stdout.trim().split("\n").at(-1));
    }
}

for(const profile of ["buildroot", "net", "alpine", "study"]) {
    test(`${profile}: system channel, teacher terminal and replay of the recording`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "channels-"));
        try {
            const journal_file = join(dir, "channels.json");
            const recorded = await driver("channels", profile, journal_file, SNAP(profile));
            assert.equal(recorded.ok, true, JSON.stringify(recorded));
            assert.ok(recorded.date_diff_s < DATE_TOLERANCE_S);
            assert.deepEqual(recorded.ports, [0, 1, 2]);
            assert.match(recorded.timeout_message, /Агент не відповів/);

            const { events } = JSON.parse(readFileSync(journal_file, "utf8"));
            const console_text = events.filter(event => event.t === "serial" && !event.p).map(event => event.data).join("");
            assert.doesNotMatch(console_text, /date -s|@req|@res/);
            assert.ok(events.filter(event => event.p === 1).every(event => event.by === "system"));
            assert.ok(events.filter(event => event.p === 2).every(event => event.by === "teacher"));

            const replayed = await driver("replay", journal_file, SNAP(profile));
            assert.equal(replayed.ok, true, JSON.stringify(replayed));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
}
