// Checks the worker protocol types the way app/machine/worker.mjs uses them. It needs the WebWorker lib, which
// conflicts with DOM in one compilation (duplicate identifiers), so it has its own config: tsconfig.worker.json.
import { create_machine } from "../core/engine.mjs";
import type { EngineMachine } from "../core/engine.mjs";
import type { LogDelta, WorkerMessage, WorkerReplies, WorkerRequest } from "../machine/worker_protocol.mjs";

let machine: EngineMachine | null = null;
let sent = 0;

const post = (message: WorkerMessage, transfer: Transferable[] = []): void => self.postMessage(message, transfer);

function log_delta(m: EngineMachine): LogDelta | null {
    const from = Math.min(sent, m.events.length);
    const events = m.events.slice(from);
    if(from === sent && events.length === 0) return null;
    sent = m.events.length;
    return { from, events };
}

async function handle(msg: WorkerRequest): Promise<WorkerReplies[WorkerRequest["op"]]> {
    if(msg.op === "start") {
        const m = create_machine(msg.params);
        machine = m;
        m.on("serial", data => post({ op: "serial", data, vtime: m.vtime() }, [data.buffer]));
        m.on("status", status => post({ op: "status", status, log: log_delta(m) }));
        m.on("end", info => post({ op: "end", ...info }));
        m.on("error", message => post({ op: "error", message, log: log_delta(m) }));
        m.on("snapshot", snap => post({ op: "snapshot", snap, log: log_delta(m) }));
        await m.ready;
        return { rate0: m.rate0, status: m.status() };
    }
    if(machine === null) throw new Error("not started");
    if(msg.op === "check") return machine.check({ pause: msg.pause });
    if(msg.op === "journal") return { events: machine.events, rate0: machine.rate0 };
    if(msg.op === "run_until") return machine.run_until(msg.target);
    if(msg.op === "type") machine.type(msg.data, msg.by, msg.port);
    return undefined;
}

self.onmessage = async ({ data: msg }: MessageEvent<WorkerRequest>) => {
    try {
        const value = await handle(msg);
        if(msg.id !== undefined) self.postMessage({ op: "done", id: msg.id, value } satisfies Partial<WorkerMessage>);
    }
    catch(e) {
        post({ op: "error", id: msg.id, message: e instanceof Error ? e.message : String(e) });
    }
};

// @ts-expect-error a request with an unknown op
export const bad_request: WorkerRequest = { op: "reboot" };
