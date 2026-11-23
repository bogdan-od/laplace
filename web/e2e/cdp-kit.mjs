// Browser plumbing shared by the screenshot scripts: waiting, API calls, a Chromium over CDP and a page driver.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close_browser, remove_profile } from "../../app/test/browser/browser_cleanup.mjs";

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// `mobile`: the window is emulated as a phone (the viewport tag is honoured, touch input).
export function create_kit({ base, width, height, scale, mobile = false, boot_tries = 480, player_tries = 720 }) {
    const BASE = base;
    const WIDTH = width;
    const HEIGHT = height;
    const SCALE = scale;
    const BOOT_TRIES = boot_tries;
    const PLAYER_TRIES = player_tries;
    async function wait_for(fn, tries, pause_ms, what) {
        for(let i = 0; i < tries; i++) {
            try { const value = await fn(); if(value) return value; } catch { /* not ready yet */ }
            await sleep(pause_ms);
        }
        throw new Error(`timeout waiting for ${what}`);
    }

    async function api(method, path, body, cookie) {
        const res = await fetch(BASE + path, {
            method,
            headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        if(!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
        return { json: text ? JSON.parse(text) : null, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
    }

    function connect(url) {
        const ws = new WebSocket(url);
        const waiting = new Map();
        const listeners = [];
        let id = 0;
        ws.onmessage = ({ data }) => {
            const msg = JSON.parse(data);
            if(msg.id && waiting.has(msg.id)) {
                const { done, fail } = waiting.get(msg.id);
                waiting.delete(msg.id);
                if(msg.error) fail(new Error(`CDP: ${msg.error.message}`)); else done(msg.result);
            } else for(const fn of listeners) fn(msg);
        };
        return new Promise(r => { ws.onopen = () => r({
            send: (method, params = {}) => new Promise((done, fail) => { const n = ++id; waiting.set(n, { done, fail }); ws.send(JSON.stringify({ id: n, method, params })); }),
            on: fn => listeners.push(fn),
            close: () => ws.close(),
        }); });
    }

    function report_page_problems(tag) {
        return msg => {
            if(msg.method === "Runtime.exceptionThrown") {
                console.log(`EXCEPTION[${tag}]`, msg.params.exceptionDetails.exception?.description?.slice(0, 400) ?? msg.params.exceptionDetails.text);
            } else if(msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
                console.log(`CONSOLE.error[${tag}]`, msg.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 300));
            }
        };
    }


    async function page_driver(cdp, tag) {
        cdp.on(report_page_problems(tag));
        await cdp.send("Runtime.enable");
        await cdp.send("Page.enable");
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile });
        await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
        const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
        const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
        const key = (type, params) => cdp.send("Input.dispatchKeyEvent", { type, ...params });
        const driver = {
            cdp, evaluate, exists,
            open: url => cdp.send("Page.navigate", { url }),
            wait_selector: (selector, tries = 120) => wait_for(() => exists(selector), tries, 250, `selector ${selector}`),
            wait_gone: (selector, tries = 40) => wait_for(async () => !(await exists(selector)), tries, 250, `${selector} to disappear`),
            wait_count: (selector, count, tries = 120) => wait_for(async () => (await driver.count(selector)) === count, tries, 250, `${count} x ${selector}`),
            wait_text: (text, tries = 80) => wait_for(async () => (await driver.body_text()).includes(text), tries, 250, `the text '${text}'`),
            text_of: selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`),
            attr_of: (selector, name) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)})`),
            count: selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
            body_text: () => evaluate("document.body.innerText"),
            // Puts the element under the top of the scroll container (nearest scrollable ancestor), not under a sticky bar.
            scroll_to: selector => evaluate(`(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if(!el) return false;
                let box = el.parentElement;
                while(box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
                if(!box) { el.scrollIntoView({ block: "start" }); return true; }
                box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
                return true;
            })()`),
            fill: (selector, text) => evaluate(`(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if(!el) return false;
                const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(text)});
                el.dispatchEvent(new Event("input", { bubbles: true }));
                return true;
            })()`),
            select_value: (selector, value) => evaluate(`(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if(!el) return false;
                Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
                el.dispatchEvent(new Event("change", { bubbles: true }));
                return true;
            })()`),
            // Radix opens menus on pointerdown, so a real mouse click is needed (element.click() is not enough).
            click: async selector => {
                const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
                if(!point) throw new Error(`no element ${selector}`);
                await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
                await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
                await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
            },
            // Clicks the first element of the selector whose text contains `text`.
            click_text: async (selector, text) => {
                const found = await evaluate(`(() => {
                    document.querySelectorAll("[data-e2e-target]").forEach(el => el.removeAttribute("data-e2e-target"));
                    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(item => item.innerText.includes(${JSON.stringify(text)}));
                    if(!el) return false;
                    el.setAttribute("data-e2e-target", "1");
                    return true;
                })()`);
                if(!found) throw new Error(`no '${text}' in ${selector}`);
                await driver.click('[data-e2e-target="1"]');
            },
            escape: async () => {
                await key("keyDown", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
                await key("keyUp", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
            },
            console_lines: async () => (await evaluate(`(document.querySelector('[data-testid="terminal"] .xterm-rows')?.innerText ?? '')`)).split("\n").map(line => line.trim()),
            type_line: async (text, terminal = '[data-testid="terminal"]') => {
                await evaluate(`document.querySelector(${JSON.stringify(terminal + " .xterm-helper-textarea")})?.focus()`);
                for(const ch of text) {
                    await key("keyDown", { key: ch, text: ch });
                    await key("keyUp", { key: ch });
                }
                await key("keyDown", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
                await key("keyUp", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            },
            park_mouse: () => cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: WIDTH - 4, y: HEIGHT - 4 }),
            // Waits until nothing is loading, no toast is up (unless the toast is the subject) and the terminals stopped printing.
            settle: async (keep_toast = false) => {
                await driver.park_mouse();
                try {
                    await wait_for(async () => !(await evaluate(`/Завантаження/.test(document.body.innerText)`)) && !(await exists('[aria-busy="true"]')) && (keep_toast || !(await exists('[data-sonner-toast]'))), 80, 250, "the page to stop loading");
                } catch(error) { console.log(`WARN settle: ${error.message}`); }
                let previous = null;
                for(let i = 0; i < 20; i++) {
                    const now = await evaluate(`[...document.querySelectorAll('.xterm-rows')].map(el => el.innerText).join("|")`);
                    if(now === previous) break;
                    previous = now;
                    await sleep(700);
                }
                await sleep(keep_toast ? 500 : 300);
            },
            set_height: async height => {
                await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: SCALE, mobile });
                await sleep(500);
            },
        };
        driver.wait_prompt = () => wait_for(async () => { const lines = (await driver.console_lines()).filter(Boolean); return /[#$%]$/.test(lines.at(-1) ?? ""); }, BOOT_TRIES, 250, "shell prompt");
        driver.has_line = async text => (await driver.console_lines()).includes(text);
        driver.run = async (text, expect) => {
            await driver.type_line(text);
            if(expect) await wait_for(() => driver.has_line(expect), 120, 250, `'${expect}' in the console after '${text}'`);
            else await sleep(1500);
        };
        // The player of one recording: ready, not seeking, the command list drawn.
        driver.wait_player = async () => {
            await driver.wait_selector('[data-testid="player"][data-phase="ready"]', PLAYER_TRIES);
            await wait_for(async () => (await driver.attr_of('[data-testid="player"]', "data-seeking")) === "false", PLAYER_TRIES, 250, "the player to stop seeking");
            await driver.wait_selector('[data-testid="command-item"]', 40);
        };
        // Goes to a command of the list: the last one, or the last one whose text contains `text`.
        driver.seek_command = async text => {
            const index = await evaluate(`(() => {
                const items = [...document.querySelectorAll('[data-testid="command-item"]')];
                const hit = ${JSON.stringify(text ?? "")} === "" ? items.length - 1 : items.map(el => el.innerText).findLastIndex(t => t.includes(${JSON.stringify(text ?? "")}));
                if(hit >= 0) items[hit].setAttribute("data-e2e-target", "1");
                return hit;
            })()`);
            if(index < 0) throw new Error(`no command '${text}' in the player`);
            await driver.click('[data-e2e-target="1"]');
            await wait_for(async () => (await driver.attr_of('[data-testid="player"]', "data-seeking")) === "false", PLAYER_TRIES, 250, "the player to stop seeking");
            // Either the terminal shows output, or the player reports a replay defect (a product defect, not a failure of the script).
            let defect = "";
            await wait_for(async () => {
                const broken = await driver.body_text();
                if(broken.includes("Машина зупинилась")) { defect = broken.match(/Машина зупинилась[^\n]*/)[0]; return true; }
                return (await driver.console_lines()).filter(Boolean).length > 1;
            }, 120, 250, "the terminal to show output");
            if(defect) throw new Skip(`the player stops after a click on a command: ${defect}`);
        };
        return driver;
    }

    function launch_chrome(port, profile) {
        return spawn("chromium-browser", [
            "--headless=new", "--disable-features=BackForwardCache", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`, "--lang=uk", "about:blank",
        ], { stdio: "ignore", env: { ...process.env, LANGUAGE: "uk" } }); // native widgets (file input) follow the browser locale
    }

    async function open_browser(port, tag) {
        const profile = mkdtempSync(join(tmpdir(), `shots-cdp-${tag}-`));
        const chrome = launch_chrome(port, profile);
        const targets = () => fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
        const first = await wait_for(async () => (await targets()).find(t => t.type === "page"), 80, 250, "chromium");
        const cdp = await connect(first.webSocketDebuggerUrl);
        const page = await page_driver(cdp, tag);
        const current_login = () => page.evaluate(`fetch("/api/me").then(r => r.ok ? r.json() : null).then(me => me?.login ?? null)`);
        // A signed-in browser is redirected away from /login, so the session is ended through the API first.
        const sign_out = async () => {
            await page.open(`${BASE}/login`);
            await wait_for(async () => (await page.evaluate("location.origin")) === BASE && (await page.evaluate("document.readyState")) === "complete", 80, 250, "the app origin");
            if(await current_login()) await page.evaluate(`fetch("/api/auth/logout", { method: "POST" }).then(() => true)`);
            await page.open(`${BASE}/login`);
            await page.wait_selector('input[autocomplete="username"]');
        };
        const sign_in = async ({ login, password }) => {
            if((await page.evaluate("location.origin")) === BASE && (await current_login()) === login) return;
            await sign_out();
            await page.fill('input[autocomplete="username"]', login);
            await page.fill('input[type="password"]', password);
            await page.click('form button[type="submit"]');
            await wait_for(async () => (await page.evaluate("location.pathname")) !== "/login", 80, 250, `leaving /login as ${login}`);
        };
        const close = async () => { cdp.close(); await close_browser(chrome, port); await remove_profile(profile); };
        return { page, sign_in, sign_out, close };
    }
    return { wait_for, api, open_browser };
}
