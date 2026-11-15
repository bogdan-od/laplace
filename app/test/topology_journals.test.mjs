import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate_topology } from "../net/topology.mjs";
import { checked_journals, launch_topology, save_topology_journals } from "../net/topology_journals.mjs";

const sample = () => JSON.parse(readFileSync(new URL("../topologies/router-on-a-stick.json", import.meta.url), "utf8"));
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeMachine {
    calls;
    handlers = new Map();
    constructor(id, calls) { this.id = id; this.calls = calls; }
    on(name, fn) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]); }
    emit(name, value) { for(const fn of this.handlers.get(name) ?? []) fn(value); }
    async start() { this.calls.push(`${this.id}:start`); }
    set_speed(x) { this.calls.push(`${this.id}:speed${x}`); }
    async go_live() { this.calls.push(`${this.id}:go_live`); }
    async check(options) { this.calls.push(`${this.id}:check${options?.pause ? ":pause" : ""}`); }
    resume() { this.calls.push(`${this.id}:resume`); }
    async journal() { this.calls.push(`${this.id}:journal`); return { header: { machine: this.id }, events: [] }; }
}

const make = ids => {
    const calls = [];
    return { calls, machines: new Map(ids.map(id => [id, new FakeMachine(id, calls)])) };
};

test("go_live for everyone only after the last machine has reached the end of its journal", async () => {
    const { calls, machines } = make(["a", "b", "c"]);
    const phases = [];
    const done = launch_topology(machines, new Set(["a", "b"]), { on_phase: phase => phases.push(phase) });
    await tick();
    machines.get("a").emit("end", {});
    await tick();
    assert.ok(!calls.some(call => call.endsWith("go_live")), "go_live before the end of journal b");
    machines.get("b").emit("end", {});
    await done;
    const first = calls.findIndex(call => call.endsWith("go_live"));
    assert.deepEqual(calls.slice(first).sort(), ["a:go_live", "b:go_live"]);
    assert.ok(!calls.includes("c:go_live"));
    assert.ok(calls.includes("a:speed0") && calls.includes("b:speed0") && !calls.includes("c:speed0"));
    assert.deepEqual(phases, ["replay", "live"]);
});

test("a machine without a journal does not wait and does not get go_live", async () => {
    const { calls, machines } = make(["a", "c"]);
    const done = launch_topology(machines, new Set(["a"]));
    await tick();
    assert.ok(calls.includes("c:start"));
    machines.get("a").emit("end", {});
    await done;
    assert.ok(!calls.includes("c:go_live"));
});

test("without any machine with a journal, live mode right away without go_live", async () => {
    const { calls, machines } = make(["a", "b"]);
    await launch_topology(machines, new Set());
    assert.deepEqual(calls, ["a:start", "b:start"]);
});

test("an error of one machine stops the launch: nobody goes live", async () => {
    const { calls, machines } = make(["a", "b"]);
    const phases = [];
    const done = launch_topology(machines, new Set(["a", "b"]), { on_phase: phase => phases.push(phase) });
    await tick();
    machines.get("a").emit("end", {});
    machines.get("b").emit("error", "розбіжність: подія 7");
    await assert.rejects(done, /Машина "b".*розбіжність: подія 7/);
    assert.ok(!calls.some(call => call.endsWith("go_live")));
    assert.deepEqual(phases, ["replay"]);
});

test("a machine start error also rejects the launch", async () => {
    const { calls, machines } = make(["a", "b"]);
    machines.get("b").start = async () => { throw new Error("знімок не завантажено"); };
    await assert.rejects(launch_topology(machines, new Set(["a"])), /знімок не завантажено/);
    assert.ok(!calls.includes("a:go_live"));
});

test("recording: check with pause on all machines before journal, resume after, the result passes validate_topology", async () => {
    const desc = sample();
    const { calls, machines } = make(desc.machines.map(machine => machine.id));
    const saved = await save_topology_journals(desc, machines);
    const last_check = Math.max(...calls.map((call, i) => call.includes(":check") ? i : -1));
    const first_journal = calls.findIndex(call => call.endsWith(":journal"));
    const last_journal = Math.max(...calls.map((call, i) => call.endsWith(":journal") ? i : -1));
    const first_resume = calls.findIndex(call => call.endsWith(":resume"));
    assert.ok(last_check >= 0 && last_check < first_journal, `call order: ${calls}`);
    assert.ok(last_journal < first_resume, `the pause was removed before the last journal: ${calls}`);
    assert.equal(calls.filter(call => call.endsWith(":check:pause")).length, 3);
    assert.equal(calls.filter(call => call.endsWith(":resume")).length, 3);
    assert.deepEqual(Object.keys(saved.journals).sort(), ["pc1", "r1", "srv"]);
    assert.equal(saved.journals.r1.header.machine, "r1");
    assert.deepEqual(validate_topology(saved), []);
    assert.equal(desc.journals, undefined, "the original description does not change");
});

test("recording: a check refusal on one machine does not leave the others paused and gives no journals", async () => {
    const desc = sample();
    const { calls, machines } = make(desc.machines.map(machine => machine.id));
    machines.get("r1").check = async () => { throw new Error("машину не запущено"); };
    await assert.rejects(save_topology_journals(desc, machines), /машину не запущено/);
    assert.ok(!calls.some(call => call.endsWith(":journal")));
    assert.equal(calls.filter(call => call.endsWith(":resume")).length, 3);
});

test("recording: a machine that was paused before the call stays paused", async () => {
    const { calls, machines } = make(["a", "b", "c"]);
    machines.get("b").user_paused = true;
    const journals = await checked_journals(machines);
    assert.equal(journals.length, 3);
    assert.deepEqual(calls.filter(call => call.endsWith(":resume")).sort(), ["a:resume", "c:resume"]);
    assert.ok(calls.includes("b:check:pause"), "check on a paused machine is still called");
});

test("recording: a check timeout is an error naming the silent machine, the journals are not taken, the rest are restored", async () => {
    const { calls, machines } = make(["a", "b", "c"]);
    let answer;
    machines.get("b").check = options => new Promise(resolve => { calls.push("b:check:pause"); answer = resolve; });
    await assert.rejects(checked_journals(machines, { timeout_ms: 20 }), error => /"b"/.test(error.message) && !/"a"|"c"/.test(error.message) && /не відповіла/.test(error.message));
    assert.ok(!calls.some(call => call.endsWith(":journal")));
    assert.deepEqual(calls.filter(call => call.endsWith(":resume")).sort(), ["a:resume", "b:resume", "c:resume"]);
    answer();
    await tick();
    assert.equal(calls.filter(call => call === "b:resume").length, 2, "the silent machine gets resume as soon as check has run");
});

test("recording: the timeout does not touch a machine paused by the user", async () => {
    const { calls, machines } = make(["a", "b"]);
    machines.get("b").user_paused = true;
    machines.get("a").check = () => new Promise(() => {});
    machines.get("b").check = () => new Promise(() => {});
    await assert.rejects(checked_journals(machines, { timeout_ms: 20 }), /"a", "b"/);
    assert.deepEqual(calls.filter(call => call.endsWith(":resume")), ["a:resume"]);
});

test("validate_topology: journals of a foreign machine and not an object", () => {
    const desc = sample();
    desc.journals = { ghost: {}, pc1: [], srv: {} };
    const errors = validate_topology(desc);
    assert.ok(errors.some(error => error.includes('"ghost"')), JSON.stringify(errors));
    assert.ok(errors.some(error => error.includes('"pc1"')), JSON.stringify(errors));
    assert.equal(errors.length, 2);
    desc.journals = [];
    assert.ok(validate_topology(desc).some(error => error.includes("journals")));
    desc.journals = { pc1: {} };
    assert.deepEqual(validate_topology(desc), []);
});

test("recording: a stale \"paused\" status (a second submit in a row) does not leave the machine paused", async () => {
    const { calls, machines } = make(["a", "b"]);
    machines.get("a").status_now = { paused: true };
    await checked_journals(machines);
    assert.deepEqual(calls.filter(call => call.endsWith(":resume")).sort(), ["a:resume", "b:resume"]);
});
