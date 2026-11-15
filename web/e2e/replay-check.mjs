// One-shot browser check of /dev/replay: starts the built server and `vite preview`,
// opens the page in headless Chromium over CDP and waits for the replay to end.
// Build first: (cd server && npm run build) && (cd web && VITE_DEV_PAGES=1 npx vite build).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PREVIEW_PORT = 4173;
const CDP_PORT = 9334;
const URL_UNDER_TEST = `http://127.0.0.1:${PREVIEW_PORT}/dev/replay`;
const DEADLINE_MS = 180_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wait_for(fn, tries, pause_ms) {
    for(let i = 0; i < tries; i++) {
        try { const value = await fn(); if(value) return value; } catch { /* not ready yet */ }
        await sleep(pause_ms);
    }
    throw new Error("timeout waiting for readiness");
}

function connect(url) {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let id = 0;
    ws.onmessage = ({ data }) => {
        const msg = JSON.parse(data);
        if(msg.id && waiting.has(msg.id)) {
            const { done, fail } = waiting.get(msg.id);
            waiting.delete(msg.id);
            if(msg.error) fail(new Error(`CDP: ${msg.error.message}`)); else done(msg.result);
        }
        if(msg.method === "Runtime.exceptionThrown") console.log("EXC", msg.params.exceptionDetails.exception?.description?.slice(0, 300));
    };
    return new Promise(r => { ws.onopen = () => r({
        send: (method, params = {}) => new Promise((done, fail) => { const n = ++id; waiting.set(n, { done, fail }); ws.send(JSON.stringify({ id: n, method, params })); }),
        close: () => ws.close(),
    }); });
}

async function main() {
    const server = spawn("node", ["server/dist/server/src/main.js"], { cwd: ROOT, stdio: "inherit" });
    const preview = spawn("npx", ["vite", "preview", "--port", String(PREVIEW_PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: join(ROOT, "web"), stdio: "ignore" });
    const profile = mkdtempSync(join(tmpdir(), "replay-cdp-"));
    const chrome = spawn("chromium-browser", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    let ok = false;
    try {
        await wait_for(async () => (await fetch(`http://127.0.0.1:8086/api/images`)).ok, 50, 200);
        await wait_for(async () => (await fetch(URL_UNDER_TEST)).ok, 50, 200);
        const target = await wait_for(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === "page"), 50, 200);
        const cdp = await connect(target.webSocketDebuggerUrl);
        await cdp.send("Runtime.enable");
        await cdp.send("Page.navigate", { url: URL_UNDER_TEST });
        const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
        const began = Date.now();
        let state = "";
        while(Date.now() - began < DEADLINE_MS) {
            state = await evaluate(`document.querySelector('[data-testid=state]')?.textContent ?? ''`).catch(() => "");
            if(state.startsWith("ended") || state.startsWith("failed")) break;
            await sleep(500);
        }
        const text = await evaluate(`document.querySelector('.xterm-rows')?.innerText ?? ''`);
        const has_prompt = /~%\s*$/m.test(text.replace(/\s+$/, "")) || text.includes("~%");
        console.log("state:", state, "wall_ms:", Date.now() - began);
        console.log("terminal tail:", JSON.stringify(text.trim().slice(-200)));
        ok = state.startsWith("ended") && has_prompt;
        cdp.close();
    }
    finally {
        await close_browser(chrome, CDP_PORT);
        preview.kill();
        server.kill();
        await remove_profile(profile);
    }
    console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
    process.exitCode = ok ? 0 : 1;
}

void main();
