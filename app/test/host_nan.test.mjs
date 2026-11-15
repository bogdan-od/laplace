// Host NaN sign: the function, the journal header field, the read_journal check and the hint for a replay divergence.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HOST_NAN_SIGNS, host_nan } from "../core/host_nan.mjs";
import { FORMAT, read_journal } from "../core/journal.mjs";

const run = promisify(execFile);
const DRIVER = fileURLToPath(new URL("./engine.node.mjs", import.meta.url));
const BOOT_SNAP = fileURLToPath(new URL("../../images/buildroot-boot.snap", import.meta.url));
const TIMEOUT_MS = 120000;
const ARCH_PHRASE = "запис зроблено на іншій архітектурі процесора";
const WRONG_HASH = "0000000000000000";

async function driver(...args) {
    try {
        const { stdout } = await run("node", [DRIVER, ...args], { timeout: TIMEOUT_MS });
        return JSON.parse(stdout.trim().split("\n").at(-1));
    } catch(error) {
        if(!error.stdout) throw error;
        return JSON.parse(error.stdout.trim().split("\n").at(-1));
    }
}

const opposite = sign => HOST_NAN_SIGNS.find(other => other !== sign);
const minimal = host_nan_field => ({ header: { format: FORMAT, seed: 1, host_nan: host_nan_field }, events: [] });

test("host_nan returns neg or pos and does not change between calls", () => {
    assert.ok(HOST_NAN_SIGNS.includes(host_nan()));
    assert.equal(host_nan(), host_nan());
});

test("read_journal accepts neg, pos and a journal without the field, rejects the rest", () => {
    for(const sign of HOST_NAN_SIGNS) assert.doesNotThrow(() => read_journal(minimal(sign)));
    assert.doesNotThrow(() => read_journal(minimal(undefined)));
    for(const bad of ["x", "", null, 1, true]) assert.throws(() => read_journal(minimal(bad)), /host_nan/, String(bad));
});

test("a freshly recorded journal contains host_nan, a divergence on another architecture is explained", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-nan-"));
    try {
        const journal_file = join(dir, "journal.json");
        const recorded = await driver("check", "buildroot", journal_file, BOOT_SNAP);
        assert.equal(recorded.ok, true, JSON.stringify(recorded));
        const journal = JSON.parse(readFileSync(journal_file, "utf8"));
        assert.equal(journal.header.host_nan, host_nan());

        const last_check = journal.events.findLastIndex(event => event.t === "check");
        journal.events[last_check].h = WRONG_HASH;
        const outcomes = {};
        for(const [label, sign] of [["other", opposite(host_nan())], ["same", host_nan()], ["absent", undefined]]) {
            journal.header.host_nan = sign;
            const file = join(dir, `${label}.json`);
            writeFileSync(file, JSON.stringify(journal));
            outcomes[label] = await driver("replay", file, BOOT_SNAP);
        }
        assert.equal(outcomes.other.ok, false);
        assert.ok(outcomes.other.error.includes(ARCH_PHRASE), outcomes.other.error);
        assert.ok(outcomes.other.error.includes(`запис ${opposite(host_nan())}, тут ${host_nan()}`), outcomes.other.error);
        for(const label of ["same", "absent"]) {
            assert.equal(outcomes[label].ok, false, label);
            assert.match(outcomes[label].error, /розбіжність стану/, label);
            assert.ok(!outcomes[label].error.includes(ARCH_PHRASE), `${label}: ${outcomes[label].error}`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
