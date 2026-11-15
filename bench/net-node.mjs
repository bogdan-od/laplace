// node bench/net-node.mjs [runs]
// Network benchmark, Node variant: two net machines in two worker_threads (app/machine/node_worker.mjs, as on
// the server), frames go through a Switch in the main thread, commands through the system channel (ttyS1). Live mode
// from net-boot.snap. Prints JSON: TCP 1 MB (nc), time by the host clock and by the guest's /proc/uptime; ping -c 20
// (RTT by the guest clock).
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { AgentChannel } from "../app/machine/agent_channel.mjs";
import { Switch } from "../app/net/switch.mjs";
import { decode_snapshot } from "../app/core/snapfile.mjs";
import { boot_snapshot_path, net_setup_command } from "../app/profiles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") + "/";
const BYTES = 1 << 20;
const runs = Number(process.argv[2] ?? 3);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const snapshot = await decode_snapshot(new Uint8Array(fs.readFileSync(boot_snapshot_path(ROOT, "net"))));

async function create(n, sw) {
    const worker = new Worker(ROOT + "app/machine/node_worker.mjs");
    let seq = 0;
    const waiting = new Map();
    const agent = new AgentChannel(text => worker.postMessage({ op: "type", data: text, by: "system", port: 1 }));
    let on_out = null;
    worker.on("message", msg => {
        if(msg.op === "serial1") agent.feed(msg.data);
        else if(msg.op === "net_out") on_out?.(msg.frame);
        else if(msg.op === "error") console.error("worker error", n, msg.message);
        else if(msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    });
    const request = body => new Promise(resolve => { const id = ++seq; waiting.set(id, resolve); worker.postMessage({ ...body, id }); });
    const reply = await request({ op: "start", params: { profile: "net", seed: 1000 + n, epoch: Math.floor(Date.now()), events: [], on_journal_end: "live", check_every_ms: 10000, recorded_host_nan: null, boot_digest: snapshot.clock.ram, speed: 1 } });
    if(reply.op === "error") throw new Error(reply.message);
    const port = sw.add_port(frame => worker.postMessage({ op: "net_in", frame }, [frame.buffer]));
    on_out = frame => port.receive(frame);
    worker.postMessage({ op: "type", data: "\n", by: "student", port: 0 });
    return { worker, sys: (cmd, timeout = 120000) => agent.request(cmd, timeout), stop: () => worker.terminate() };
}

const sw = new Switch();
const t0 = performance.now();
const a = await create(1, sw);
const b = await create(2, sw);
const boot_ms = Math.round(performance.now() - t0);
await sleep(1500);
for(const [m, n] of [[a, 1], [b, 2]]) {
    const r = await m.sys(net_setup_command(n).trim());
    if(r.rc !== 0) throw new Error("setup: " + r.output);
}
await sleep(1000);
if(process.env.DEBUG_SEQ) { for(const [who, cmd, wait] of JSON.parse(process.env.DEBUG_SEQ)) { console.log('>', who, cmd); console.log((await (who === 'a' ? a : b).sys(cmd)).output); if(wait) await sleep(wait); } process.exit(0); }
const result = { boot_both_ms: boot_ms, tcp: [], ping: null };
const ping = await a.sys("ping -c 20 10.0.0.2", 120000);
result.ping_raw = ping.output.slice(-400);
const m = /min\/avg\/max = ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(ping.output);
result.ping = m ? { min_ms: +m[1], avg_ms: +m[2], max_ms: +m[3] } : null;
result.ping_loss = /(\d+)% packet loss/.exec(ping.output)?.[1] ?? null;
for(let i = 0; i < runs; i++) {
    const file = `/tmp/r${i}`;
    await b.sys(`rm -f ${file}; (sleep 600 | nc -l -p 5000 | wc -c > ${file}) >/dev/null 2>&1 &`);
    await sleep(500);
    const began = performance.now();
    const sent = await a.sys(`u0=$(cut -d' ' -f1 /proc/uptime); head -c ${BYTES} /dev/zero | nc 10.0.0.2 5000; echo rc=$?; u1=$(cut -d' ' -f1 /proc/uptime); echo uptime $u0 $u1`, 600000);
    let got = "";
    for(let k = 0; k < 600 && !got.trim(); k++) { got = (await b.sys(`cat ${file} 2>/dev/null`)).output; if(!got.trim()) await sleep(300); }
    const wall_ms = Math.round(performance.now() - began);
    const up = /uptime ([\d.]+) ([\d.]+)/.exec(sent.output);
    result.tcp.push({ run: i + 1, host_wall_ms: wall_ms, guest_s: up ? +(up[2] - up[1]).toFixed(2) : null, received: got.trim(), sender_out: sent.output.trim().slice(-200), kb_per_s_host: Math.round(BYTES / 1024 / (wall_ms / 1000)) });
}
console.log(JSON.stringify(result, null, 1));
a.stop(); b.stop();
process.exit(0);
