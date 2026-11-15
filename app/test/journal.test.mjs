import { test } from "node:test";
import assert from "node:assert/strict";
import { FORMAT, read_journal, event_times, duration_ms, commands, journal_digest } from "../core/journal.mjs";
import { hash_text } from "../core/digest.mjs";

const journal_of = (events, header = {}) => ({ header: { format: FORMAT, seed: 1, ...header }, events });
const serial = (data, by) => ({ t: "serial", data, by });

test("read_journal accepts a journal of the right format", () => {
    const journal = journal_of([{ c: 1, w: 0, t: "serial", data: "a" }]);
    assert.strictEqual(read_journal(journal), journal);
});

test("read_journal rejects a foreign format", () => {
    assert.throws(
        () => read_journal({ header: { format: "v86-replay/6" }, events: [] }),
        /Журнал іншого формату: v86-replay\/6, потрібен v86-replay\/9/,
    );
});

test("read_journal rejects a /7 journal with a clear message", () => {
    assert.throws(
        () => read_journal({ header: { format: "v86-replay/7" }, events: [] }),
        /Журнал старого формату v86-replay\/7.*запишіть сесію заново/,
    );
});

test("read_journal rejects a /8 journal with a clear message", () => {
    assert.throws(
        () => read_journal({ header: { format: "v86-replay/8" }, events: [] }),
        /Журнал старого формату v86-replay\/8.*запишіть сесію заново.*v86-replay\/9/,
    );
});

test("read_journal requires an integer seed in the header", () => {
    assert.throws(() => read_journal({ header: { format: FORMAT, seed: null }, events: [] }), /header\.seed/);
});

test("read_journal rejects an event without c", () => {
    const journal = journal_of([{ c: 1, w: 0, t: "serial", data: "a" }, { w: 0, t: "serial", data: "b" }]);
    assert.throws(() => read_journal(journal), /Подія 1: немає поля c/);
});

test("event_times computes time through two rate events from zero", () => {
    // start: at 0, ms 0, per_ms 300000
    // e0 serial c=300000 w=0:  0 + 300000/300000 + 0 = 1
    // e1 rate   c=600000 w=0.5 (per_ms 150000): 0 + 600000/300000 + 0.5 = 2.5
    //           new rate: ms = 0 + 2 = 2, at 600000
    // e2 rate   c=900000 w=0 (per_ms 600000): 2 + (900000-600000)/150000 + 0 = 4
    //           new rate: ms = 2 + 2 = 4, at 900000
    // e3 serial c=1500000 w=1: 4 + (1500000-900000)/600000 + 1 = 6
    const journal = journal_of([
        { c: 300000, w: 0, t: "serial", data: "a" },
        { c: 600000, w: 0.5, t: "rate", per_ms: 150000 },
        { c: 900000, w: 0, t: "rate", per_ms: 600000 },
        { c: 1500000, w: 1, t: "serial", data: "b" },
    ]);
    assert.deepStrictEqual(Array.from(event_times(journal)), [1, 2.5, 4, 6]);
    assert.equal(duration_ms(journal), 6);
});

test("event_times takes the starting rate from rate0", () => {
    // rate0: at 1000, ms 10, per_ms 1000
    // e0 serial c=3000 w=0: 10 + (3000-1000)/1000 + 0 = 12
    // e1 rate   c=5000 w=0.25 (per_ms 2000): 10 + (5000-1000)/1000 + 0.25 = 14.25
    //           new rate: ms = 10 + 4 = 14, at 5000
    // e2 serial c=9000 w=0: 14 + (9000-5000)/2000 + 0 = 16
    const journal = journal_of([
        { c: 3000, w: 0, t: "serial", data: "a" },
        { c: 5000, w: 0.25, t: "rate", per_ms: 2000 },
        { c: 9000, w: 0, t: "serial", data: "b" },
    ], { rate0: { at: 1000, ms: 10, per_ms: 1000 } });
    assert.deepStrictEqual(Array.from(event_times(journal)), [12, 14.25, 16]);
    assert.equal(duration_ms(journal), 16);
});

test("duration_ms without events is 0", () => {
    const journal = journal_of([]);
    assert.equal(duration_ms(journal), 0);
    assert.equal(event_times(journal).length, 0);
});

test("journal_digest computes hash_text of the events JSON", () => {
    const journal = journal_of([serial("ls\r")]);
    assert.equal(journal_digest(journal), hash_text(JSON.stringify(journal.events)));
});

test("commands: a plain command and an empty line", () => {
    assert.deepStrictEqual(commands([serial("ls\r")]), [
        { text: "ls", index: 0, start: 0, by: "student", port: 0, uncertain: false },
    ]);
    assert.deepStrictEqual(commands([serial("  \r")]), []);
});

test("commands: backspace deletes the last character", () => {
    assert.deepStrictEqual(commands([serial("lss\x7f\r")]).map(c => c.text), ["ls"]);
    assert.deepStrictEqual(commands([serial("lss\b\r")]).map(c => c.text), ["ls"]);
});

test("commands: Ctrl-C and Ctrl-U clear the buffer", () => {
    assert.deepStrictEqual(commands([serial("rm -rf\x03ls\r")]).map(c => c.text), ["ls"]);
    assert.deepStrictEqual(commands([serial("abc\x15ls\r")]).map(c => c.text), ["ls"]);
});

test("commands: arrow up marks the command inexact", () => {
    assert.deepStrictEqual(commands([serial("ls\x1b[A\r")]), [
        { text: "ls", index: 0, start: 0, by: "student", port: 0, uncertain: true },
    ]);
});

test("commands: Tab marks the command inexact", () => {
    assert.deepStrictEqual(commands([serial("ls\t\r")]), [
        { text: "ls", index: 0, start: 0, by: "student", port: 0, uncertain: true },
    ]);
});

test("commands: arrow left moves the cursor, text is inserted to the left", () => {
    assert.deepStrictEqual(commands([serial("l\x1b[Ds\r")]), [
        { text: "sl", index: 0, start: 0, by: "student", port: 0, uncertain: false },
    ]);
});

test("commands: an ESC sequence split between events", () => {
    const found = commands([serial("cat\x1b["), serial("A\r")]);
    assert.deepStrictEqual(found, [{ text: "cat", index: 1, start: 0, by: "student", port: 0, uncertain: true }]);
    assert.deepStrictEqual(commands([serial("x\x1b"), serial("[Dy\r")]).map(c => c.text), ["yx"]);
});

test("commands: pws, ↑, Backspace, d, Enter give pwd without inexactness", () => {
    assert.deepStrictEqual(commands([serial("pws\r"), serial("\x1b[A\x7fd\r")]), [
        { text: "pws", index: 0, start: 0, by: "student", port: 0, uncertain: false },
        { text: "pwd", index: 1, start: 1, by: "student", port: 0, uncertain: false },
    ]);
});

test("commands: echo \"\", ←, text inside quotes, Enter", () => {
    assert.deepStrictEqual(commands([serial("echo \"\"\x1b[DWtf is it doing here???\r")]), [
        { text: "echo \"Wtf is it doing here???\"", index: 0, start: 0, by: "student", port: 0, uncertain: false },
    ]);
});

test("commands: insertion in the middle of the line", () => {
    assert.deepStrictEqual(commands([serial("ad\x1b[Db\r")]).map(c => c.text), ["abd"]);
});

test("commands: ESC O D also moves the cursor", () => {
    assert.deepStrictEqual(commands([serial("ab\x1bODX\r")]), [
        { text: "aXb", index: 0, start: 0, by: "student", port: 0, uncertain: false },
    ]);
});

test("commands: ↑↑↓ scroll through history", () => {
    const found = commands([serial("one\rtwo\r\x1b[A\x1b[A\x1b[B\r")]);
    assert.deepStrictEqual(found.map(c => [c.text, c.uncertain]), [
        ["one", false], ["two", false], ["two", false],
    ]);
});

test("commands: ↓ past the last entry gives an empty line", () => {
    assert.deepStrictEqual(commands([serial("one\r\x1b[A\x1b[Bx\r")]).map(c => c.text), ["one", "x"]);
});

test("commands: ↑ with empty history keeps the line and marks it inexact", () => {
    assert.deepStrictEqual(commands([serial("\x1b[Aab\r")]), [
        { text: "ab", index: 0, start: 0, by: "student", port: 0, uncertain: true },
    ]);
});

test("commands: repeating the same line does not duplicate history", () => {
    const found = commands([serial("one\rone\r\x1b[A\x1b[A\r")]);
    assert.deepStrictEqual(found[2], { text: "one", index: 0, start: 0, by: "student", port: 0, uncertain: true });
});

test("commands: history is shared by the student and the teacher", () => {
    const found = commands([serial("ls\r"), serial("\x1b[A\r", "teacher")]);
    assert.deepStrictEqual(found[1], { text: "ls", index: 1, start: 1, by: "teacher", port: 0, uncertain: false });
});

test("commands: Home, End and Delete", () => {
    assert.deepStrictEqual(commands([serial("abc\x1b[H\x1b[3~\x1b[F!\r")]).map(c => c.text), ["bc!"]);
    assert.deepStrictEqual(commands([serial("bc\x01a\x05z\r")]).map(c => c.text), ["abcz"]);
});

test("commands: an unknown ESC sequence marks the line inexact", () => {
    assert.deepStrictEqual(commands([serial("ls\x1b[1;5C\r")]), [
        { text: "ls", index: 0, start: 0, by: "student", port: 0, uncertain: true },
    ]);
});

test("commands: the student and teacher buffers are separate", () => {
    const found = commands([
        serial("ca"),
        serial("su\r", "teacher"),
        serial("t\r"),
    ]);
    assert.deepStrictEqual(found, [
        { text: "su", index: 1, start: 1, by: "teacher", port: 0, uncertain: false },
        { text: "cat", index: 2, start: 0, by: "student", port: 0, uncertain: false },
    ]);
});

test("commands: the inexact flag does not carry over to the other buffer", () => {
    const found = commands([serial("ls\t", "teacher"), serial("pwd\r")]);
    assert.deepStrictEqual(found, [{ text: "pwd", index: 1, start: 1, by: "student", port: 0, uncertain: false }]);
});

test("commands: start is the event of the command's first key", () => {
    const found = commands([serial("ec"), serial("ho one\r"), serial("\r"), serial("x"), serial("\x03"), serial("ls"), serial("\r")]);
    assert.deepStrictEqual(found.map(c => [c.text, c.start, c.index]), [["echo one", 0, 1], ["ls", 5, 6]]);
});

test("read_journal: header.lesson is validated", () => {
    const events = [{ c: 1, w: 0, t: "serial", data: "a" }, { c: 2, w: 0, t: "serial", data: "b" }];
    const with_lesson = lesson => journal_of(events, { lesson });
    const note = { t: "note", at: 1, text: "тут" };
    assert.doesNotThrow(() => read_journal(with_lesson([note, { t: "self", from: 0, to: 2, text: "сам" }])));
    assert.throws(() => read_journal(with_lesson("x")), /масивом/);
    assert.throws(() => read_journal(with_lesson([{ ...note, at: 3 }])), /некоректний/);
    assert.throws(() => read_journal(with_lesson([{ t: "self", from: 1, to: 1, text: "" }])), /некоректний/);
    assert.throws(() => read_journal(with_lesson([{ t: "note", at: 0 }])), /тексту/);
    assert.throws(() => read_journal(with_lesson([
        { t: "self", from: 0, to: 2, text: "a" }, { t: "self", from: 1, to: 2, text: "b" },
    ])), /перетинаються/);
});

test("commands: the system channel (port 1) is skipped, port 2 has its own buffer and history", () => {
    const on_port = (data, p, by) => ({ t: "serial", data, p, ...(by ? { by } : {}) });
    const found = commands([
        serial("ls\r"),
        on_port("@req 1 Zm9v\n", 1, "system"),
        on_port("touch /tmp/t\r", 2, "teacher"),
        on_port("\x1b[A\r", 2, "teacher"),
        serial("\x1b[A\r"),
    ]);
    assert.deepStrictEqual(found.map(c => [c.port, c.text]), [[0, "ls"], [2, "touch /tmp/t"], [2, "touch /tmp/t"], [0, "ls"]]);
});
