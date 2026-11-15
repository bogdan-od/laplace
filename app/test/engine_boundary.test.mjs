// Snapshot boundaries in the core. A journal of a short live recording (buildroot): for EVERY event, a replay from the
// start takes a snapshot in the tick where
// the event was applied, and a new process continues from it to the end of the journal; all checks must match. Required
// cases:
// a snapshot in a tick with a clock event; a snapshot after which the next event sits at the same c with a larger w
// (guest in HLT, another tick).
// Second journal: an hour of idling as one clock (extra ≈ 3 600 000); replay and resume after it match, and the guest
// answers input.
// Every step is a separate process: the engine replaces globals, one machine per process.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const BOUNDARY = fileURLToPath(new URL("./engine_boundary.node.mjs", import.meta.url));
const ENGINE = fileURLToPath(new URL("./engine.node.mjs", import.meta.url));
const START = fileURLToPath(new URL("../../images/buildroot-boot.snap", import.meta.url));
const TIMEOUT_MS = 600000;
const PARALLEL = 4;
const HOUR_MS = 3_600_000;
const RECORD_ATTEMPTS = 5;

async function driver(script, ...args) {
    try {
        const { stdout } = await run("node", [script, ...args], { timeout: TIMEOUT_MS, maxBuffer: 1 << 26 });
        return JSON.parse(stdout.trim().split("\n").at(-1));
    } catch(error) {
        if(!error.stdout) throw error;
        return JSON.parse(error.stdout.trim().split("\n").at(-1));
    }
}

async function in_parallel(items, fn) {
    const results = [];
    let at = 0;
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
        while(at < items.length) { const i = at++; results[i] = await fn(items[i]); }
    }));
    return results;
}

// One snapshot per event, and each snapshot is already past its event; events of one tick share files.
async function snapshot_every_event(journal_file, dir) {
    const { events } = JSON.parse(readFileSync(journal_file, "utf8"));
    const taken = await driver(BOUNDARY, "snap_all", journal_file, START, dir);
    assert.equal(taken.ok, true, JSON.stringify(taken));
    assert.equal(taken.snapshots.length, events.length);
    taken.snapshots.forEach((snap, i) => {
        assert.equal(snap.index, i);
        assert.ok(snap.next > i, `snapshot of event ${i} has next ${snap.next}`);
    });
    return { events, snapshots: taken.snapshots };
}

async function resume_all(journal_file, snapshots) {
    const files = [...new Set(snapshots.map(snap => snap.file))];
    const results = await in_parallel(files, async file => ({ file, reply: await driver(ENGINE, "resume", journal_file, file) }));
    for(const { file, reply } of results) assert.equal(reply.ok, true, `${file}: ${JSON.stringify(reply)}`);
    return files.length;
}

test("a snapshot in the tick of every event: resume from it reaches the end of the journal without divergence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boundary-"));
    try {
        const journal_file = join(dir, "short.json");
        // A pair of events at the same c in different ticks happens only when a check of a guest in HLT was not
        // preceded by a clock event (catching up
        // with real time), and that depends on the host: the recording is repeated until such a pair exists (one
        // attempt succeeds ≈7 times out of 9).
        let events, snapshots, same_c_later_tick = [];
        for(let attempt = 0; attempt < RECORD_ATTEMPTS && !same_c_later_tick.length; attempt++) {
            const recorded = await driver(BOUNDARY, "record", "buildroot", journal_file, START, "short");
            assert.equal(recorded.ok, true, JSON.stringify(recorded));
            events = JSON.parse(readFileSync(journal_file, "utf8")).events;
            // Only clock changes w within a tick, so a non-clock event followed by the same c with a larger w opens
            // another tick.
            same_c_later_tick = events.flatMap((event, index) =>
                event.t !== "clock" && events[index + 1]?.c === event.c && events[index + 1].w > event.w ? [index] : []);
        }
        assert.ok(same_c_later_tick.length > 0, `in ${RECORD_ATTEMPTS} recording there is no event before an event on the same c with a larger w`);
        ({ events, snapshots } = await snapshot_every_event(journal_file, join(dir, "snaps")));

        assert.ok(events.length <= 80, `journal too long: ${events.length}`);
        assert.ok(snapshots.some(({ index }) => events[index].t === "clock"), "no snapshot in a tick with a clock event");
        assert.ok(same_c_later_tick.every(index => snapshots.some(snap => snap.index === index)), "no snapshot before an event on the same c with a larger w");
        assert.ok(snapshots.some(({ index }) => events[index].t === "serial"), "no snapshot in a tick with input");

        const files = await resume_all(journal_file, snapshots);
        console.log(`# events ${events.length}, snapshot files ${files}, before an event on the same c with a larger w: ${same_c_later_tick.length}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an hour of idle in one clock: replay and resume after it agree, the guest answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boundary-hour-"));
    try {
        const journal_file = join(dir, "hour.json");
        const recorded = await driver(BOUNDARY, "record", "buildroot", journal_file, START, "hour");
        assert.equal(recorded.ok, true, JSON.stringify(recorded));
        const { events } = JSON.parse(readFileSync(journal_file, "utf8"));
        const jump = events.find(event => event.t === "clock" && event.extra >= HOUR_MS * 0.99);
        assert.ok(jump, "no one-hour clock in the journal");

        const replayed = await driver(ENGINE, "replay", journal_file, START);
        assert.equal(replayed.ok, true, JSON.stringify(replayed));
        const { snapshots } = await snapshot_every_event(journal_file, join(dir, "snaps"));
        await resume_all(journal_file, snapshots);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("1x replay after a one-hour clock event: pause, speed and snapshot do not wait out the hour of sleep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boundary-slow-"));
    try {
        const journal_file = join(dir, "hour.json");
        const recorded = await driver(BOUNDARY, "record", "buildroot", journal_file, START, "hour");
        assert.equal(recorded.ok, true, JSON.stringify(recorded));
        const journal = JSON.parse(readFileSync(journal_file, "utf8"));
        const jump = journal.events.findIndex(event => event.t === "clock" && event.extra >= HOUR_MS * 0.99);
        assert.ok(jump >= 0, "no one-hour clock in the journal");
        const truncated = join(dir, "until-jump.json");
        writeFileSync(truncated, JSON.stringify({ header: journal.header, events: journal.events.slice(0, jump + 1) }));

        const result = await driver(ENGINE, "replay_slow", truncated, START);
        assert.equal(result.ok, true, JSON.stringify(result));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
