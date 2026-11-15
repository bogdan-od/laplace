// Shared teardown of the browser tests: close Chromium through CDP, wait for the process to exit, remove the profile.
// A failure to remove the profile is only printed and does not change the test's exit code.
import { rmSync } from "node:fs";

const EXIT_WAIT_MS = 15000;
const RM_ATTEMPTS = 40;
const RM_PAUSE_MS = 250;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function exited(chrome) {
    return chrome.exitCode !== null || chrome.signalCode !== null;
}

function wait_exit(chrome, timeout_ms) {
    if(exited(chrome)) return Promise.resolve(true);
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), timeout_ms);
        chrome.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
}

async function browser_close(cdp_port) {
    const version = await (await fetch(`http://127.0.0.1:${cdp_port}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP ws")); });
    ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    setTimeout(() => ws.close(), 500);
}

export async function close_browser(chrome, cdp_port) {
    if(!exited(chrome)) {
        try {
            await browser_close(cdp_port);
        } catch (error) {
            console.error("CLEANUP Browser.close failed:", error.message);
        }
    }
    if(await wait_exit(chrome, EXIT_WAIT_MS)) return;
    console.error("CLEANUP Chromium did not exit within", EXIT_WAIT_MS, "ms, SIGKILL");
    chrome.kill("SIGKILL");
    await wait_exit(chrome, EXIT_WAIT_MS);
}

export async function remove_profile(dir) {
    let last;
    for(let attempt = 0; attempt < RM_ATTEMPTS; attempt += 1) {
        try {
            rmSync(dir, { recursive: true, force: true });
            return;
        } catch (error) {
            last = error;
            await sleep(RM_PAUSE_MS);
        }
    }
    console.error("CLEANUP profile not removed:", dir, last.message);
}
