// node bench/browser/run-replay.mjs <chromium|firefox> [jobs.json] [out.json] [--tabs N] [--limit N]
// Serves the project root plus a job queue, starts the browser on replay.html, collects the results.
// Without jobs.json (or with "-") every journal in server/demo/journals is replayed, the smallest files first;
// --limit N keeps the first N. The result goes to out/bench/replay-<browser>.json unless out.json is given.
// The browser starts as in the project's tests (headless, a temporary profile); no network requests go outside.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const positional = [];
const flags = new Map();
const argv = process.argv.slice(2);
for(let i = 0; i < argv.length; i++) {
    if(argv[i].startsWith("--")) flags.set(argv[i], argv[++i]);
    else positional.push(argv[i]);
}
const [browser, jobs_arg = "-", out_arg] = positional;
if(browser !== "chromium" && browser !== "firefox") {
    console.error("usage: node bench/browser/run-replay.mjs <chromium|firefox> [jobs.json] [out.json] [--tabs N] [--limit N]");
    process.exit(2);
}
const tabs = Number(flags.get("--tabs") || 1);
const out_file = out_arg ?? path.join(ROOT, "out", "bench", `replay-${browser}.json`);
const DEADLINE_MS = Number(process.env.DEADLINE_MS || 3 * 3600_000);
const PORT = Number(process.env.PORT || 8765);
const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css" };
const DEMO_JOURNALS = "server/demo/journals";
function demo_jobs() {
    const files = fs.readdirSync(ROOT + DEMO_JOURNALS).filter(name => name.endsWith(".json") && name !== "marks.json")
        .map(name => ({ name, size: fs.statSync(ROOT + DEMO_JOURNALS + "/" + name).size })).sort((a, b) => a.size - b.size);
    return files.slice(0, Number(flags.get("--limit") || files.length)).map(({ name }) => ({ kind: "replay", path: `${DEMO_JOURNALS}/${name}` }));
}
const jobs = jobs_arg === "-" ? demo_jobs() : JSON.parse(fs.readFileSync(jobs_arg, "utf8"));
fs.mkdirSync(path.dirname(out_file), { recursive: true });
const queue = jobs.map((job, index) => ({ ...job, index }));
const results = [];
const finished = new Set();
const t_start = Date.now();

const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
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
const urls = Array.from({ length: tabs }, (_, i) => `http://127.0.0.1:${PORT}/bench/browser/replay.html?tab=${i}`);
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
fs.writeFileSync(out_file, JSON.stringify({ browser, how, wall_total_ms: Date.now() - t_start, tabs, results }, null, 1));
console.log(`${how}: ${results.length} results in ${Math.round((Date.now() - t_start) / 1000)} s`);
process.exit(0);
