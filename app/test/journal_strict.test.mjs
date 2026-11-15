import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FORMAT, JOURNAL_LIMITS, MAX_INSTR_PER_MS, MIN_INSTR_PER_MS, check_journal_strict } from "../core/journal.mjs";

const NET_14 = Buffer.alloc(14).toString("base64");
const NET_1522 = Buffer.alloc(1522).toString("base64");

// Real format /8 journals: the topology (in git) and recordings of the Node driver and the server (if they are on
// disk).
const REAL_DIRS = ["./fixtures/topology-journals", "./out", "../data/journals"];

function real_journals() {
    const found = [];
    for(const dir of REAL_DIRS) {
        const path = fileURLToPath(new URL(dir + "/", import.meta.url));
        if(!existsSync(path)) continue;
        for(const name of readdirSync(path).filter(name => name.endsWith(".json"))) {
            let json;
            try { json = JSON.parse(readFileSync(path + name, "utf8")); } catch { continue; }
            if(json?.header?.format === FORMAT) found.push({ name: dir + "/" + name, json });
        }
    }
    return found;
}

const journal = events => ({ header: { format: FORMAT, seed: 7, profile: "buildroot", rate0: { at: 0, ms: 0, per_ms: 300000 } }, events });
const base_events = () => [
    { c: 10, w: 0, t: "serial", data: "ls\n", by: "student" },
    { c: 20, w: 0, t: "net", data: NET_14 },
    { c: 30, w: 5.5, t: "clock", extra: 40 },
    { c: 40, w: 45.5, t: "rate", per_ms: 123456 },
    { c: 50, w: 45.5, t: "check", h: "0123456789abcdef", m: "fedcba9876543210" },
];

test("all real /8 journals pass the strict check", () => {
    const all = real_journals();
    assert.ok(all.length >= 3, "no topology journals found in test/fixtures/topology-journals");
    for(const { name, json } of all) assert.doesNotThrow(() => check_journal_strict(json), name);
});

test("serial with ports 1 and 2 passes the strict check", () => {
    const events = base_events();
    events.splice(1, 0, { c: 15, w: 0, t: "serial", data: "@req 1 eA==\n", p: 1, by: "system" }, { c: 16, w: 0, t: "serial", data: "ls\r", p: 2, by: "teacher" });
    assert.doesNotThrow(() => check_journal_strict(journal(events)));
});

test("a journal with all event types and 14- and 1522-byte frames passes", () => {
    const events = [...base_events(), { c: 60, w: 45.5, t: "net", data: NET_1522 }];
    assert.doesNotThrow(() => check_journal_strict(journal(events)));
});

const REJECTED = [
    ["c = Infinity", e => { e[1].c = Infinity; }, /Подія 1 \(net\): c = Infinity/],
    ["c = 1e18", e => { e[4].c = 1e18; }, /Подія 4 \(check\): c = 1000000000000000000/],
    ["fractional c", e => { e[0].c = 1.5; }, /Подія 0.*c = 1\.5/],
    ["negative c", e => { e[0].c = -1; }, /Подія 0.*c = -1/],
    ["c = NaN", e => { e[2].c = NaN; }, /Подія 2.*c = NaN/],
    ["w = Infinity", e => { e[2].w = Infinity; }, /Подія 2.*w = Infinity/],
    ["negative w", e => { e[0].w = -0.5; }, /Подія 0.*w = -0\.5/],
    ["c decreases", e => { e[3].c = 25; }, /Подія 3.*порядок порушено/],
    ["w decreases at equal c", e => { e[3].c = 30; e[3].w = 1; }, /Подія 3.*порядок порушено/],
    ["per_ms = 0", e => { e[3].per_ms = 0; }, /Подія 3 \(rate\): per_ms = 0/],
    ["per_ms = NaN", e => { e[3].per_ms = NaN; }, /per_ms = NaN/],
    ["per_ms below the minimum", e => { e[3].per_ms = MIN_INSTR_PER_MS - 1; }, /per_ms/],
    ["per_ms above the maximum", e => { e[3].per_ms = MAX_INSTR_PER_MS + 1; }, /per_ms/],
    ["negative extra", e => { e[2].extra = -1; }, /Подія 2 \(clock\): extra = -1/],
    ["huge extra", e => { e[2].extra = 1e12; }, /extra = 1000000000000/],
    ["extra is not a number", e => { e[2].extra = "5"; }, /extra = 5/],
    ["serial.data is not a string", e => { e[0].data = 5; }, /Подія 0 \(serial\)/],
    ["serial.by is not a string", e => { e[0].by = 1; }, /by - рядок/],
    ["serial.data of tens of megabytes", e => { e[0].data = "x".repeat(20 * 2 ** 20); }, /Подія 0 \(serial\)/],
    ["net.data is not a string", e => { e[1].data = [1, 2]; }, /Подія 1 \(net\)/],
    ["net.data is not base64", e => { e[1].data = "не base64!"; }, /base64/],
    ["net.data 3-byte frame", e => { e[1].data = Buffer.alloc(3).toString("base64"); }, /кадр 3 байт/],
    ["net.data 60000-byte frame", e => { e[1].data = Buffer.alloc(60000).toString("base64"); }, /Подія 1 \(net\)/],
    ["check.h is a number", e => { e[4].h = 12345; }, /h - 16/],
    ["check.h of the wrong shape", e => { e[4].h = "XYZ"; }, /h - 16/],
    ["check.m missing", e => { delete e[4].m; }, /m - 16/],
    ["check.m of the wrong shape", e => { e[4].m = "XYZ"; }, /m - 16/],
    ["serial.p outside the port list", e => { e[0].p = 3; }, /p/],
    ["serial.p is not a number", e => { e[0].p = "1"; }, /p/],
    ["unknown type", e => { e[2].t = "reboot"; }, /Подія 2: невідомий тип "reboot"/],
    ["type from the prototype", e => { e[2].t = "constructor"; }, /невідомий тип/],
];

for(const [name, mutate, message] of REJECTED) {
    test(`the strict check rejects: ${name}`, () => {
        const events = base_events();
        mutate(events);
        assert.throws(() => check_journal_strict(journal(events)), message);
    });
}

test("the strict check rejects a foreign format and rate0 with per_ms = 0", () => {
    const wrong = journal(base_events());
    wrong.header.format = "v86-replay/6";
    assert.throws(() => check_journal_strict(wrong), /іншого формату/);
    const zero = journal(base_events());
    zero.header.rate0.per_ms = 0;
    assert.throws(() => check_journal_strict(zero), /rate0: per_ms = 0/);
    const nan = journal(base_events());
    nan.header.host_nan = "x";
    assert.throws(() => check_journal_strict(nan), /host_nan/);
});

test("rate0: null (a header before the first Worker start) passes the strict check", () => {
    const early = journal([]);
    early.header.rate0 = null;
    assert.doesNotThrow(() => check_journal_strict(early));
});

test("clock with an extra of 2 days passes, of 31 days does not (laptop sleep)", () => {
    const DAY_MS = 86_400_000;
    const jump = days => { const e = base_events(); e[2].extra = days * DAY_MS; return journal(e); };
    assert.doesNotThrow(() => check_journal_strict(jump(2)));
    assert.doesNotThrow(() => check_journal_strict(jump(30)));
    assert.throws(() => check_journal_strict(jump(31)), /Подія 2 \(clock\): extra = 2678400000/);
    assert.equal(JOURNAL_LIMITS.max_extra_ms, 30 * DAY_MS);
});

test("the default ceilings can be replaced", () => {
    const events = base_events();
    assert.throws(() => check_journal_strict(journal(events), { max_events: 4 }), /подій 5, ліміт 4/);
    assert.throws(() => check_journal_strict(journal(events), { max_instructions: 45 }), /Подія 4.*c = 50/);
    assert.throws(() => check_journal_strict(journal(events), { max_extra_ms: 10 }), /extra = 40/);
    assert.throws(() => check_journal_strict(journal(events), { max_serial_chars: 2 }), /Подія 0 \(serial\)/);
    assert.throws(() => check_journal_strict(journal(events), { max_warp_ms: 10 }), /w = 45\.5/);
    assert.doesNotThrow(() => check_journal_strict(journal(events), { max_events: 5 }));
    assert.equal(JOURNAL_LIMITS.max_events, 500_000, "the defaults are not spoiled by the calls above");
});

test("the event count ceiling fires before the events are parsed", () => {
    const events = Array.from({ length: JOURNAL_LIMITS.max_events + 1 }, () => ({ c: 0, w: 0, t: "serial", data: "" }));
    assert.throws(() => check_journal_strict(journal(events)), /подій 500001/);
});
