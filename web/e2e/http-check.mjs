// Check without a browser: server (built) + `vite` with its proxy, then the same
// requests the screens make: teacher registers, logs in, creates a class, student joins by code.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITE = "http://127.0.0.1:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
    cookie = "";
    async call(method, path, body) {
        const res = await fetch(VITE + path, {
            method,
            headers: { ...(body ? { "content-type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const set = res.headers.get("set-cookie");
        if (set) this.cookie = set.split(";")[0];
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text.slice(0, 120); }
        console.log(`${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 220)}`);
        return { status: res.status, json };
    }
}

async function waitFor(fn) {
    for (let i = 0; i < 60; i++) {
        try { if (await fn()) return; } catch { /* not ready */ }
        await sleep(250);
    }
    throw new Error("not ready");
}

const dir = mkdtempSync(join(tmpdir(), "http-check-"));
const server = spawn("node", ["server/dist/server/src/main.js"], {
    cwd: ROOT, stdio: "ignore", env: { ...process.env, LAPLACE_DB: join(dir, "db.sqlite"), LAPLACE_JOURNALS: join(dir, "journals") },
});
const vite = spawn("npx", ["vite", "--port", "5173", "--strictPort", "--host", "127.0.0.1"], { cwd: join(ROOT, "web"), stdio: "ignore" });
try {
    await waitFor(async () => (await fetch(VITE + "/api/images")).ok);
    for (const page of ["/", "/join/ABC", "/src/main.tsx", "/src/app/router.tsx"]) {
        const r = await fetch(VITE + page);
        console.log(`GET ${page} -> ${r.status} ${r.headers.get("content-type")}`);
    }
    const teacher = new Client();
    const anon = new Client();
    await anon.call("GET", "/api/me");
    await teacher.call("POST", "/api/auth/register", { name: "Олена Іваненко", login: "olena", password: "short", role: "teacher" });
    await teacher.call("POST", "/api/auth/register", { name: "Олена Іваненко", login: "olena", password: "password-1", role: "teacher" });
    await teacher.call("POST", "/api/auth/logout");
    teacher.cookie = "";
    await teacher.call("POST", "/api/auth/login", { login: "olena", password: "wrong-password" });
    await teacher.call("POST", "/api/auth/login", { login: "olena", password: "password-1" });
    const created = await teacher.call("POST", "/api/classes", { name: "КН-21", subject: "Комп'ютерні мережі" });
    await teacher.call("GET", "/api/classes");
    await teacher.call("GET", "/api/search?q=%D0%BA%D0%BD");
    await teacher.call("GET", "/api/notifications");
    const code = created.json.invite_code;
    await anon.call("GET", "/api/invites/NOPE1234");
    await anon.call("GET", `/api/invites/${code}`);
    await anon.call("GET", `/api/invites/${code.toLowerCase()}`);
    const student = new Client();
    await student.call("POST", "/api/auth/register", { name: "Іван Петренко", login: "ivan", password: "password-2", role: "student", invite_code: code });
    await student.call("GET", "/api/classes");
    await student.call("POST", `/api/invites/${code}/accept`);
    await teacher.call("GET", "/api/notifications");
    await teacher.call("GET", "/api/classes");
    await teacher.call("POST", "/api/auth/logout");
    await teacher.call("GET", "/api/classes");
} finally {
    server.kill();
    vite.kill();
    rmSync(dir, { recursive: true, force: true });
}
