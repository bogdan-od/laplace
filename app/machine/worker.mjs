// Worker entry: one deterministic machine per Worker (engine.mjs patches the
// Worker's globals). Protocol: worker_protocol.d.mts. Requests with an `id` get
// {op: "done", id, value} or {op: "error", id, message}.
import { create_machine } from "../core/engine.mjs";

let m = null;
// How many journal events have already been sent to the main thread (it keeps a copy in case the Worker crashes).
let sent = 0;
const post = (msg, transfer = []) => self.postMessage(msg, transfer);

function snapshot_transfer(snap) {
    const list = [snap.state];
    for(const [, bytes] of snap.chunks) if(bytes) list.push(bytes.buffer);
    for(const [, , bytes] of snap.jit) if(bytes) list.push(bytes.buffer);
    return list;
}

function log_delta() {
    const from = Math.min(sent, m.events.length);
    const events = m.events.slice(from);
    if(from === sent && events.length === 0) return null;
    sent = m.events.length;
    return { from, events };
}

function start(params) {
    m = create_machine(params);
    sent = params.events.length;
    m.on("serial", data => post({ op: "serial", data, vtime: m.vtime() }, [data.buffer]));
    m.on("serial1", data => post({ op: "serial1", data }, [data.buffer]));
    m.on("serial2", data => post({ op: "serial2", data }, [data.buffer]));
    m.on("net_out", frame => post({ op: "net_out", frame }, [frame.buffer]));
    m.on("status", status => post({ op: "status", status, log: log_delta() }));
    m.on("end", info => post({ op: "end", ...info }));
    m.on("error", message => post({ op: "error", message, log: log_delta() }));
    m.on("snapshot", snap => post({ op: "snapshot", snap, log: log_delta() }, snapshot_transfer(snap)));
    return m.ready.then(() => ({ rate0: m.rate0, status: m.status() }));
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
    snapshot: () => m.snapshot(),
    journal: () => ({ events: m.events, rate0: m.rate0 }),
    digest: () => m.ram_digest(),
};

self.onmessage = async ({ data: msg }) => {
    const op = OPS[msg.op];
    if(!op) { post({ op: "error", id: msg.id, message: `unknown command ${msg.op}` }); return; }
    try {
        const value = await op(msg);
        if(msg.id === undefined) return;
        const transfer = msg.op === "snapshot" ? snapshot_transfer(value) : [];
        post({ op: "done", id: msg.id, value }, transfer);
    }
    catch(e) {
        post({ op: "error", id: msg.id, message: e.message || String(e) });
    }
};
