// node bench/replay-node.mjs <journal.json> [--speed0]
// Replay of one journal by our core in Node at full speed. Prints one JSON line:
// ok, error (divergence text), wall_ms (from ready to end), events, number of checks, instructions and duration from
// the journal.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create_machine } from "../app/core/engine.mjs";
import { read_journal, duration_ms } from "../app/core/journal.mjs";
import { decode_snapshot } from "../app/core/snapfile.mjs";
import { PROFILES, boot_snapshot_path } from "../app/profiles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") + "/";
const file = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const journal = read_journal(JSON.parse(fs.readFileSync(file, "utf8")));
const { header, events } = journal;
const summary = {
    file, profile: header.profile, events: events.length,
    checks: events.filter(e => e.t === "check").length, net_events: events.filter(e => e.t === "net").length,
    instr_journal: events.length ? events[events.length - 1].c : 0, duration_ms_journal: Math.round(duration_ms(journal)),
    session_ms: Math.round(duration_ms(journal) - (header.rate0?.ms ?? 0)),
    session_instr: (events.length ? events[events.length - 1].c : 0) - (header.rate0?.at ?? 0),
    rate0_at: header.rate0?.at ?? 0, rate0_ms: header.rate0?.ms ?? 0,
};
const finish = (extra, code) => { console.log(JSON.stringify({ ...summary, ...extra })); process.exit(code); };
const snapshot = header.start ? await decode_snapshot(new Uint8Array(fs.readFileSync(boot_snapshot_path(ROOT, header.start.snapshot.replace(/-boot$/, ""))))) : null;
if(snapshot && header.start.digest !== snapshot.clock.ram) finish({ ok: false, error: "snapshot digest differs from journal start digest", skipped: true }, 2);
const m = create_machine({ config: PROFILES[header.profile].config(ROOT), seed: header.seed, reseed: !!snapshot, epoch: header.epoch, snapshot, events, check_every_ms: 0, recorded_host_nan: header.host_nan });
let error = null;
m.on("error", message => { error = message; });
m.set_speed(0);
const t0 = performance.now();
await m.ready;
const ready_ms = Math.round(performance.now() - t0);
while(!m.status().ended && !error) await sleep(20);
const wall_ms = Math.round(performance.now() - t0);
if(error) finish({ ok: false, error, event_in_error: (/подія (\d+)/.exec(error) ?? [])[1] ?? null, wall_ms, ready_ms }, 1);
finish({ ok: true, wall_ms, ready_ms, instr_replay: m.instructions(), vtime_end: Math.round(m.vtime()) }, 0);
