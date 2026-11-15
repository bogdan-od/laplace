// One-off measurement: what the Alpine profile keeps in memory from 9p and what of it ends up in a snapshot.
//   node app/test/fs9p_measure.node.mjs snap|cold
// snap: start from alpine-boot.snap (as in the product); cold: cold boot (≈4 min).
// After each step it prints a JSON line: the cache of image files (MemoryFileStorage.filedata),
// inodedata (written by the guest), the size of state in the snapshot, process memory.
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { FS } from "../../v86det/lib/filesystem.js";
import { MemoryFileStorage } from "../../v86det/src/browser/filestorage.js";
import { create_machine } from "../core/engine.mjs";
import { decode_snapshot } from "../core/snapfile.mjs";
import { PROFILES } from "../profiles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const MIB = 1 << 20;
const PROMPT = PROFILES.alpine.prompt;
const STEP_TIMEOUT_MS = 600000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let fs9p = null;
const load_from_json = FS.prototype.load_from_json;
FS.prototype.load_from_json = function(...args) {
    fs9p = this;
    return load_from_json.apply(this, args);
};

// v86 loads an image file into memory whole on the first read and drops it on close (CloseInode -> uncache),
// so the cache size at any given moment says nothing: everything loaded and the peak are counted.
const loaded = { files: 0, bytes: 0, current: 0, peak: 0 };
const cache = MemoryFileStorage.prototype.cache;
MemoryFileStorage.prototype.cache = function(sha, data) {
    loaded.files += 1;
    loaded.bytes += data.byteLength;
    loaded.current += data.byteLength;
    loaded.peak = Math.max(loaded.peak, loaded.current);
    return cache.call(this, sha, data);
};
const uncache = MemoryFileStorage.prototype.uncache;
MemoryFileStorage.prototype.uncache = function(sha) {
    loaded.current -= this.filedata.get(sha)?.byteLength ?? 0;
    return uncache.call(this, sha);
};

const sum = arrays => arrays.reduce((total, data) => total + data.byteLength, 0);

async function measure(m, label) {
    const cached = fs9p.storage.storage.filedata;
    const inodedata = Object.values(fs9p.inodedata);
    const snap = await m.snapshot();
    const memory = process.memoryUsage();
    const row = {
        step: label,
        loaded_files: loaded.files,
        loaded_mib_total: +(loaded.bytes / MIB).toFixed(1),
        peak_cached_mib: +(loaded.peak / MIB).toFixed(1),
        cached_now_files: cached.size,
        cached_now_mib: +(sum([...cached.values()]) / MIB).toFixed(1),
        inodedata_files: inodedata.length,
        inodedata_mib: +(sum(inodedata) / MIB).toFixed(1),
        snapshot_state_mib: +(snap.state.byteLength / MIB).toFixed(1),
        state_gzip_mib: +(zlib.gzipSync(new Uint8Array(snap.state), { level: 1 }).length / MIB).toFixed(1),
        arraybuffers_mib: +(memory.arrayBuffers / MIB).toFixed(0),
        rss_mib: +(memory.rss / MIB).toFixed(0),
    };
    console.log(JSON.stringify(row));
    loaded.peak = loaded.current;
}

async function main() {
    const mode = process.argv[2] ?? "snap";
    const snapshot = mode === "snap" ? await decode_snapshot(new Uint8Array(fs.readFileSync(ROOT + "images/alpine-boot.snap"))) : null;
    const m = create_machine({ config: PROFILES.alpine.config(ROOT), seed: 1, snapshot, on_journal_end: "live", check_every_ms: 0 });
    let text = "";
    const decoder = new TextDecoder();
    m.on("serial", bytes => { text += decoder.decode(bytes, { stream: true }); });
    m.on("error", message => { console.log("ERROR", message); process.exit(1); });
    const at_prompt = () => text.replace(/\x1b\[6n$/, "").endsWith(PROMPT);
    const wait_prompt = async () => {
        const deadline = Date.now() + STEP_TIMEOUT_MS;
        while(!at_prompt()) {
            if(Date.now() > deadline) throw new Error("timeout waiting for the prompt");
            await sleep(50);
        }
    };
    const run = async (command, quiet) => {
        text = "";
        m.type(command + "\n");
        await sleep(300);
        await wait_prompt();
        if(!quiet) console.log("  output:", JSON.stringify(text.slice(-160)));
        return text;
    };
    const free = async () => {
        const out = await run("grep -E '^(MemFree|Cached):' /proc/meminfo", true);
        console.log("  guest meminfo:", out.replace(/\x1b\[6n/g, "").split("\r\n").slice(1, 3).join(" | "));
    };
    await m.ready;
    if(snapshot) m.type("\n");
    await wait_prompt();
    await measure(m, `${mode}: at the prompt after the start`);
    await free();
    await run("ls -la /usr/libexec/gcc/i586-alpine-linux-musl/14.2.0/lto1; apk --version; ls /var/cache/apk /etc/apk | head; df -h / | tail -1");
    await run("cat /usr/libexec/gcc/i586-alpine-linux-musl/14.2.0/lto1 > /dev/null");
    await measure(m, "cat lto1 (40.5 MB) > /dev/null");
    await free();
    await run("printf '#include <stdio.h>\\nint main(){puts(\"hi\");}\\n' > h.c && gcc h.c -o h && ./h");
    await measure(m, "gcc hello world (cc1, as, ld, headers)");
    await free();
    await run("cp /usr/lib/libcrypto.so.3 /root/c1 && cp /usr/lib/libpython3.12.so.1.0 /root/c2");
    await measure(m, "cp of two files 3.4 + 5.4 MB into /root (guest write, like unpacking a package)");
    await free();
    await run("dd if=/dev/zero of=/root/z bs=1M count=20 2>/dev/null");
    await measure(m, "dd 20 MB of zeros into /root");
    await free();
    process.exit(0);
}

main().catch(error => { console.log("FAIL", error.message); process.exit(1); });
