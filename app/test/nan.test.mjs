// NaN bits in SSE and x87 results in the guest match a real CPU: nan32.s runs in the buildroot guest
// (v86.wasm), nan64.s on the host, and 55 lines of 16 bytes are compared byte by byte. Needs as and ld from binutils.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const DRIVER = fileURLToPath(new URL("./engine.node.mjs", import.meta.url));
const BOOT_SNAP = fileURLToPath(new URL("../../images/buildroot-boot.snap", import.meta.url));
const SOURCES = fileURLToPath(new URL("./nan/", import.meta.url));
const TIMEOUT_MS = 180000;
const ROW_BYTES = 16;
const ROWS = 55;

const has_binutils = () => {
    try { execFileSync("as", ["--version"], { stdio: "ignore" }); execFileSync("ld", ["--version"], { stdio: "ignore" }); return true; }
    catch { return false; }
};

async function build(dir, name, arch, ld_args) {
    await run("as", [`--${arch}`, SOURCES + `${name}.s`, "-o", join(dir, `${name}.o`)], { cwd: SOURCES });
    await run("ld", [...ld_args, "-s", "-o", join(dir, name), join(dir, `${name}.o`)]);
    return join(dir, name);
}

test("NaN in SSE and x87: the v86.wasm guest gives the same bits as the host CPU", { skip: !has_binutils() && "no as/ld" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "nan-"));
    try {
        const guest_binary = await build(dir, "nan32", "32", ["-m", "elf_i386", "-static"]);
        const host_binary = await build(dir, "nan64", "64", []);
        const host = (await run(host_binary, [], { encoding: "buffer" })).stdout;
        const { stdout } = await run("node", [DRIVER, "run_binary", "buildroot", BOOT_SNAP, guest_binary], { timeout: TIMEOUT_MS });
        const result = JSON.parse(stdout.trim().split("\n").at(-1));
        assert.equal(result.ok, true, JSON.stringify(result));
        const guest = Buffer.from(result.stdout_base64, "base64");
        assert.equal(guest.length, ROWS * ROW_BYTES);
        const different = [];
        for(let row = 0; row < ROWS; row++) {
            const a = guest.subarray(row * ROW_BYTES, (row + 1) * ROW_BYTES).toString("hex");
            const b = host.subarray(row * ROW_BYTES, (row + 1) * ROW_BYTES).toString("hex");
            if(a !== b) different.push(`line ${row}: guest ${a}, host ${b}`);
        }
        assert.deepEqual(different, []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
