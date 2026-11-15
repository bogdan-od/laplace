// Server-side machine host: one worker_threads Worker runs one deterministic machine. engine.mjs replaces Date,
// Math.random and crypto of its whole realm, so it is loaded only here.
// Protocol: app/machine/worker_protocol.d.mts, the same requests and replies as the browser worker.mjs, except:
//   - `start` takes NodeStartParams (profile, boot digest) instead of a ready config and snapshot: the engine config
//     holds functions that cannot cross postMessage, and the boot snapshot is read from disk here, not copied from the main thread;
//   - the console (`serial`) and the teacher terminal (`serial2`) are not forwarded: a replay at full speed would flood the main thread;
//   - there is no `snapshot` request and the journal is not mirrored to the main thread (`log` is always null).
// The Worker keeps running after the machine ends (engine timers): the caller terminates it.
import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { create_machine } from "../core/engine.mjs";
import { decode_snapshot } from "../core/snapfile.mjs";
import { PROFILES, boot_snapshot_path } from "../profiles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";

let m = null;
const post = (msg, transfer = []) => parentPort.postMessage(msg, transfer);
const describe = error => (error instanceof Error ? error.message : String(error));

async function load_boot(profile, digest) {
    const snapshot = await decode_snapshot(new Uint8Array(fs.readFileSync(boot_snapshot_path(ROOT, profile))));
    if(digest !== snapshot.clock.ram) throw new Error("Знімок завантаження не той, з якого записано журнал");
    return snapshot;
}

async function start(params) {
    if(m !== null) throw new Error("the machine is already started");
    const snapshot = params.boot_digest === null ? null : await load_boot(params.profile, params.boot_digest);
    m = create_machine({
        config: PROFILES[params.profile].config(ROOT),
        seed: params.seed, epoch: params.epoch, events: params.events, next: 0,
        snapshot, reseed: snapshot !== null,
        on_journal_end: params.on_journal_end, check_every_ms: params.check_every_ms, snap_every_ms: 0,
        recorded_host_nan: params.recorded_host_nan,
    });
    m.on("serial1", data => post({ op: "serial1", data }, [data.buffer]));
    m.on("net_out", frame => post({ op: "net_out", frame }, [frame.buffer]));
    m.on("status", status => post({ op: "status", status, log: null }));
    m.on("end", info => post({ op: "end", ...info }));
    m.on("error", message => post({ op: "error", message, log: null }));
    if(params.speed !== undefined) m.set_speed(params.speed);
    await m.ready;
    return { rate0: m.rate0, status: m.status() };
}

const OPS = {
    start: msg => start(msg.params),
    type: msg => m.type(msg.data, msg.by, msg.port),
    net_in: msg => m.net_in(msg.frame),
    speed: msg => m.set_speed(msg.x),
    pause: () => m.pause(),
    resume: () => m.resume(),
    go_live: () => m.go_live(),
    check: msg => m.check({ pause: msg.pause }),
    run_until: msg => m.run_until(msg.target),
    journal: () => ({ events: m.events, rate0: m.rate0 }),
    digest: () => m.ram_digest(),
};

parentPort.on("message", async msg => {
    const op = OPS[msg.op];
    if(!op) { post({ op: "error", id: msg.id, message: `unknown request: ${msg.op}` }); return; }
    try {
        const value = await op(msg);
        if(msg.id !== undefined) post({ op: "done", id: msg.id, value });
    }
    catch(error) {
        post({ op: "error", id: msg.id, message: describe(error) });
    }
});

process.on("unhandledRejection", error => post({ op: "error", message: describe(error), log: null }));
