// Measures the agent's (ttyS1) reply latency under load. Repeats the start of the `channels` step: a fresh session, the
// date through the agent,
// then simple commands. For each request it prints host time and guest time (vtime, instructions) at sending and at the
// reply;
// a request without a reply within timeout_ms ends the run.
//   [NO_STALL=1] node agent_probe.node.mjs <profile> <start.snap> [timeout_ms=10000] [requests=6]
// NO_STALL=1: the timeout runs on the host clock without discounting emulator stalls.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create_machine } from "../core/engine.mjs";
import { decode_snapshot } from "../core/snapfile.mjs";
import { AgentChannel } from "../machine/agent_channel.mjs";
import { PROFILES, date_command, fresh_session_input } from "../profiles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const [profile, snap_file, timeout_arg = "10000", count_arg = "6"] = process.argv.slice(2);
const timeout_ms = Number(timeout_arg);
// How much host time the machine stands waiting for JIT modules to compile (the core awaits them in yield, and vtime
// does not advance).
const jit = { slow: [], calls: 0, inflight: 0, since: 0, wait_ms: 0 };
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = (...args) => {
    jit.calls++;
    if(jit.inflight++ === 0) jit.since = performance.now();
    const began = performance.now(), size = args[0]?.byteLength ?? args[0]?.length;
    return instantiate(...args).finally(() => {
        if(--jit.inflight === 0) jit.wait_ms += performance.now() - jit.since;
        if(performance.now() - began > 200) jit.slow.push({ size, ms: Math.round(performance.now() - began), at_vtime: Math.round(m.vtime()) });
    });
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Math.round(performance.now());

const snapshot = await decode_snapshot(new Uint8Array(fs.readFileSync(snap_file)));
const m = create_machine({
    config: PROFILES[profile].config(ROOT), seed: 1 + (process.pid % 1000000), epoch: Date.now(), snapshot, reseed: true,
    on_journal_end: "live", known_hashes: snapshot.hashes, check_every_ms: 0,
});
let console_text = "";
const decoder = new TextDecoder();
m.on("serial", bytes => { console_text += decoder.decode(bytes, { stream: true }); });
m.on("error", message => { console.log(JSON.stringify({ fatal: message })); process.exit(1); });
const agent = new AgentChannel(text => m.type(text, "system", 1), { stalled: process.env.NO_STALL ? () => false : () => m.stalled() });
m.on("serial1", bytes => agent.feed(bytes));

// Host event-loop lag: how late setTimeout(10) fires (an overloaded process gives large values).
let max_loop_lag = 0;
setInterval((() => { let last = now(); return () => { const t = now(); max_loop_lag = Math.max(max_loop_lag, t - last - 10); last = t; }; })(), 10);

await m.ready;
const ready_at = { host: now(), vtime: m.vtime() };
m.type(fresh_session_input());
await sleep(500);
const prompt = PROFILES[profile].prompt;
for(let waited = 0; !console_text.endsWith(prompt); waited += 50) { if(waited > 60000) { console.log(JSON.stringify({ fatal: "no prompt", tail: console_text.slice(-100) })); process.exit(1); } await sleep(50); }
const prompt_at = { host: now(), vtime: m.vtime() };

const rows = [];
for(let k = 0; k < Number(count_arg); k++) {
    const command = k === 0 ? date_command(Date.now()) : "true";
    const sent = { host: now(), vtime: m.vtime(), instr: m.instructions(), jit_calls: jit.calls, jit_wait: jit.wait_ms };
    const outcome = await agent.request(command, timeout_ms).then(() => "ok", () => "timeout");
    rows.push({ k, outcome, host_ms: now() - sent.host, guest_ms: Math.round(m.vtime() - sent.vtime), guest_instr_m: Math.round((m.instructions() - sent.instr) / 1e6), jit_calls: jit.calls - sent.jit_calls, jit_wait_ms: Math.round(jit.wait_ms - sent.jit_wait) });
    if(outcome === "timeout") break;
}
console.log(JSON.stringify({ slow_instantiate: jit.slow, pid: process.pid, boot_to_prompt_host_ms: prompt_at.host - ready_at.host, max_loop_lag, per_ms: m.status().per_ms, rows }));
process.exit(0);
