// Measures how many Worker messages reach the main thread's onmessage after terminate().
// The page runs the scenarios itself and POSTs the result to this server; works in any browser.
//   node worker_terminate.mjs chromium|firefox [runs]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close_browser, remove_profile } from "./browser_cleanup.mjs";

const PORT = 8765;
const CDP_PORT = 9341;
const RESULT_TIMEOUT_MS = 180000;
const [kind = "chromium", runs = "20"] = process.argv.slice(2);

const PAGE = `<!doctype html><meta charset="utf-8"><script>
const RUNS = ${Number(runs)};
const BURST = 50000;
const PACED = 20000;
const SPIN_MS = 300;
const SETTLE_MS = 400;
const worker_source = \`
  onmessage = ({ data: mode }) => {
    if(mode === "burst") { for(let i = 0; i < ${"${BURST}"}; i++) postMessage(i); return; }
    const channel = new MessageChannel();
    let i = 0;
    channel.port1.onmessage = () => { postMessage(i++); if(i < ${"${PACED}"}) channel.port2.postMessage(0); };
    channel.port2.postMessage(0);
  };\`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const spin = ms => { const end = performance.now() + ms; while(performance.now() < end); };
const url = URL.createObjectURL(new Blob([worker_source.replace("\${BURST}", BURST).replace("\${PACED}", PACED)]));

// mode: burst/paced - how the Worker sends; where: handler - terminate in the handler of the first message;
// spin - the same, after ${"${SPIN_MS}"} ms of main thread busy time; task - as a separate task (setTimeout 0) after the busy time.
async function one(mode, where) {
  const worker = new Worker(url);
  let got = 0, terminated_at = null, after = 0, last_seen = -1, order_ok = true;
  const spin_total = () => {};
  worker.onmessage = ({ data }) => {
    if(data !== last_seen + 1) order_ok = false;
    last_seen = data;
    got++;
    if(terminated_at !== null) { after++; return; }
    if(got > 1) return;
    if(where === "handler") { worker.terminate(); terminated_at = got; }
    else if(where === "spin") { spin(SPIN_MS); worker.terminate(); terminated_at = got; }
    else { setTimeout(() => { worker.terminate(); terminated_at = got; }, 0); spin(SPIN_MS); }
  };
  worker.postMessage(mode);
  await sleep(SPIN_MS + SETTLE_MS + 300);
  return { got, terminated_at, after, order_ok };
}

(async () => {
  const result = { ua: navigator.userAgent, runs: RUNS, burst: BURST, paced: PACED, scenarios: {} };
  for(const mode of ["burst", "paced"]) for(const where of ["handler", "spin", "task"]) {
    const rows = [];
    for(let r = 0; r < RUNS; r++) rows.push(await one(mode, where));
    const after = rows.map(x => x.after).sort((a, b) => a - b);
    result.scenarios[mode + "/" + where] = {
      after_min: after[0], after_median: after[after.length >> 1], after_max: after.at(-1),
      runs_with_after: after.filter(x => x > 0).length, got_median: rows.map(x => x.got).sort((a, b) => a - b)[rows.length >> 1],
      order_ok: rows.every(x => x.order_ok),
    };
  }
  await fetch("/result", { method: "POST", body: JSON.stringify(result) });
})();
</script>`;

const finish = Promise.withResolvers();
const server = createServer((req, res) => {
    if(req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => { res.end("ok"); finish.resolve(JSON.parse(body)); });
        return;
    }
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
});
await new Promise(resolve => server.listen(PORT, "127.0.0.1", resolve));
const profile = mkdtempSync(join(tmpdir(), "wt-"));
const url = `http://127.0.0.1:${PORT}/`;
const browser = kind === "firefox"
    ? spawn("firefox", ["--headless", "--no-remote", "--profile", profile, url], { stdio: "ignore" })
    : spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, url], { stdio: "ignore" });
const timer = setTimeout(() => finish.reject(new Error("no result")), RESULT_TIMEOUT_MS);
try {
    console.log(JSON.stringify(await finish.promise, null, 1));
}
finally {
    clearTimeout(timer);
    if(kind === "firefox") { browser.kill("SIGKILL"); await new Promise(r => browser.once("exit", r)); }
    else await close_browser(browser, CDP_PORT);
    server.close();
    await remove_profile(profile);
}
