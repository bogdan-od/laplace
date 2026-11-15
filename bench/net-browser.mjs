// node bench/net-browser.mjs [one|two-chromium|chromium-firefox] [out.json]
// Network benchmark in the browser (result: out/bench/net-<variant>.json by default). app/server.mjs (static root + room WebSocket) on PORT, result collector on
// PORT+1.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") + "/";
const [variant = "one", out_arg] = process.argv.slice(2);
const out_file = out_arg ?? path.join(ROOT, "out", "bench", `net-${variant}.json`);
fs.mkdirSync(path.dirname(out_file), { recursive: true });
const PORT = 8149;
const COLL = PORT + 1;
const DEADLINE_MS = Number(process.env.NET_DEADLINE_MIN ?? 20) * 60_000;
const results = [];
const t0 = Date.now();
const collector = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => { try { const m = JSON.parse(body); results.push({ at: Date.now() - t0, ...m }); console.log(JSON.stringify(m).slice(0, 300)); } catch {} res.end("ok"); });
});
await new Promise(r => collector.listen(COLL, "127.0.0.1", r));
const server = spawn("node", [ROOT + "app/server.mjs", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1500));
const base = `http://127.0.0.1:${PORT}/bench/browser/net.html`;
const coll = `http://127.0.0.1:${COLL}/`;
const room = "h" + Date.now();
const kids = [];
const profiles = [];
const prof = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "h-prof-")); profiles.push(d); return d; };
const CDP = 9400;
const chromium = urls => spawn("chromium-browser", ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-features=BackForwardCache,WebRtcHideLocalIpsWithMdns", `--remote-debugging-port=${CDP}`, `--user-data-dir=${prof()}`, urls[0]], { stdio: "ignore" });
const firefox = url => { const d = prof(); fs.writeFileSync(path.join(d, "user.js"), 'user_pref("media.peerconnection.ice.obfuscate_host_addresses", false);\nuser_pref("media.peerconnection.mtransport_process", false);\nuser_pref("media.peerconnection.ice.loopback", true);\nuser_pref("browser.shell.checkDefaultBrowser", false);\n'); return spawn("firefox", ["--headless", "--no-remote", "--profile", d, url], { stdio: "ignore" }); };
let expect;
if(variant === "one") { kids.push(chromium([`${base}?mode=one&collector=${encodeURIComponent(coll)}`])); expect = r => r.mode === "one" && (r.ping !== undefined || r.error); }
else if(variant === "two-chromium") {
    kids.push(chromium([`${base}?mode=two&role=a&room=${room}&collector=${encodeURIComponent(coll)}`]));
    for(let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${CDP}/json/version`); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
    await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`${base}?mode=two&role=b&room=${room}&collector=${encodeURIComponent(coll)}`)}`, { method: "PUT" });
}
else {
    kids.push(chromium([`${base}?mode=two&role=a&room=${room}&collector=${encodeURIComponent(coll)}`]));
    kids.push(firefox(`${base}?mode=two&role=b&room=${room}&collector=${encodeURIComponent(coll)}`));
}
const final = () => variant === "one" ? results.some(r => r.ping !== undefined || r.error) : results.filter(r => !r.progress && (r.got || r.ping !== undefined || r.error)).length >= 2;
while(!final() && Date.now() - t0 < DEADLINE_MS) await new Promise(r => setTimeout(r, 1000));
kids.forEach(k => k.kill("SIGTERM"));
await new Promise(r => setTimeout(r, 2000));
kids.forEach(k => k.kill("SIGKILL"));
for(const d of profiles) { try { execSync(`pkill -f -- '${d}' || true`); } catch {} fs.rmSync(d, { recursive: true, force: true }); }
server.kill(); collector.close();
fs.writeFileSync(out_file, JSON.stringify({ variant, wall_ms: Date.now() - t0, results }, null, 1));
process.exit(0);
