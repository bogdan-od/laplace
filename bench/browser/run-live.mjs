// node bench/browser/run-live.mjs <chromium|firefox> <jobs.json> <out.json> [--tabs N]
// Serves the project root plus a job queue, starts the browser on live.html, collects the results and the RSS of the
// browser. The browser starts as in the project's tests (headless, a temporary profile); no network requests go
// outside.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const [browser, jobs_file, out_file, ...rest] = process.argv.slice(2);
const tabs = Number(rest[rest.indexOf("--tabs") + 1] || 1);
const DEADLINE_MS = Number(process.env.DEADLINE_MS || 3 * 3600_000);
const PORT = Number(process.env.PORT || 8765);
const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css" };
const jobs = JSON.parse(fs.readFileSync(jobs_file, "utf8"));
const queue = jobs.map((job, index) => ({ ...job, index }));
const results = [];
const finished = new Set();
const t_start = Date.now();

const samples = [];
function rss_tree(root_pid) {
    const rows = execSync("ps -e -o pid=,ppid=,rss=,comm=", { encoding: "utf8" }).trim().split("\n").map(l => l.trim().split(/\s+/));
    const kids = new Map();
    for(const [pid, ppid, rss, comm] of rows) { if(!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push({ pid, rss: Number(rss), comm }); }
    const found = [];
    const walk = pid => { for(const k of kids.get(String(pid)) ?? []) { found.push(k); walk(k.pid); } };
    const self = rows.find(r => r[0] === String(root_pid));
    if(self) found.push({ pid: self[0], rss: Number(self[2]), comm: self[3] });
    walk(root_pid);
    let pss = 0, priv = 0;
    for(const p of found) {
        try {
            const text = fs.readFileSync(`/proc/${p.pid}/smaps_rollup`, "utf8");
            pss += Number(/^Pss:\s+(\d+)/m.exec(text)?.[1] ?? 0);
            priv += Number(/^Private_Clean:\s+(\d+)/m.exec(text)?.[1] ?? 0) + Number(/^Private_Dirty:\s+(\d+)/m.exec(text)?.[1] ?? 0);
        } catch { /* the process is gone */ }
    }
    return { total_kb: found.reduce((a, p) => a + p.rss, 0), pss_kb: pss, private_kb: priv, processes: found.length, by_comm: Object.fromEntries([...new Set(found.map(p => p.comm))].map(c => [c, found.filter(p => p.comm === c).reduce((a, p) => a + p.rss, 0)])) };
}
const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if(process.env.ISOLATED) { res.setHeader("Cross-Origin-Opener-Policy", "same-origin"); res.setHeader("Cross-Origin-Embedder-Policy", "require-corp"); }
    if(url.pathname === "/bench/sample") {
        const s = { label: url.searchParams.get("label"), at: Date.now() - t_start, ...rss_tree(child.pid) };
        samples.push(s);
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(s));
    }
    if(url.pathname === "/bench/next") {
        const job = queue.shift();
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(job ?? { kind: "done" }));
    }
    if(url.pathname === "/bench/result") {
        let body = "";
        req.on("data", c => { body += c; });
        req.on("end", () => {
            const msg = JSON.parse(body);
            if(msg.finished) finished.add(msg.tab);
            else { results.push({ ...msg, at: Date.now() - t_start }); console.log(`[${results.length}/${jobs.length}] ${msg.job.path ?? msg.job.kind} ok=${msg.result.ok} ${msg.result.wall_ms ?? ""}ms ${msg.result.error ? msg.result.error.slice(0, 200) : ""}`); }
            res.end("ok");
        });
        return;
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname));
    if(!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("no"); }
    res.setHeader("content-type", MIME[path.extname(file)] ?? "application/octet-stream");
    fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bench-prof-"));
const urls = Array.from({ length: tabs }, (_, i) => `http://127.0.0.1:${PORT}/bench/browser/live.html?tab=${i}`);
let child;
if(browser === "chromium") {
    child = spawn("chromium-browser", ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-features=BackForwardCache", `--user-data-dir=${profile}`, ...urls], { stdio: "ignore" });
}
else {
    fs.writeFileSync(path.join(profile, "user.js"), 'user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("datareporting.policy.dataSubmissionEnabled", false);\nuser_pref("browser.startup.homepage_override.mstone", "ignore");\n');
    child = spawn("firefox", ["--headless", "--no-remote", "--profile", profile, ...urls.slice(0, 1)], { stdio: "ignore" });
    // Firefox gets only the first page from the command line, so it always runs one tab (--tabs is ignored).
}
const done = new Promise(r => { const t = setInterval(() => { if(finished.size >= (browser === "chromium" ? tabs : 1)) { clearInterval(t); r("finished"); } if(Date.now() - t_start > DEADLINE_MS) { clearInterval(t); r("deadline"); } }, 500); });
const how = await done;
child.kill("SIGTERM");
await new Promise(r => setTimeout(r, 1500));
try { child.kill("SIGKILL"); execSync(`pkill -f -- '--user-data-dir=${profile}' || true; pkill -f -- '${profile}' || true`); } catch {}
server.close();
fs.rmSync(profile, { recursive: true, force: true });
fs.writeFileSync(out_file, JSON.stringify({ browser, how, wall_total_ms: Date.now() - t_start, tabs, samples, results }, null, 1));
console.log(`${how}: ${results.length} results in ${Math.round((Date.now() - t_start) / 1000)} s`);
process.exit(0);
