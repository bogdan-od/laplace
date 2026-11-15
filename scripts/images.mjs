// Downloads the machine images (boot snapshots, kernels, root filesystems, v86.wasm) into images/ and unpacks them.
//   npm run images                  everything listed in images.json
//   npm run images -- buildroot     the named profiles plus the shared files (`common`)
//   npm run images -- --force       download and unpack again even when the files match
// Archives come from $LAPLACE_IMAGES_URL (an http(s) address or a local directory), by default from the GitHub
// release named in images.json. Every archive is checked against its sha256 before it is unpacked.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const IMAGES_DIR = join(ROOT, "images");
const WORK_DIR = join(IMAGES_DIR, ".work");
const STAMP_DIR = join(IMAGES_DIR, ".stamps");
const COMMON = "common";
const MB = 1024 * 1024;
const PROGRESS_INTERVAL_MS = 150;

class UserError extends Error {}

const manifest = JSON.parse(readFileSync(join(ROOT, "images.json"), "utf8"));
const default_base = `https://github.com/${manifest.repository}/releases/download/${manifest.tag}`;

const mb = bytes => (bytes / MB).toFixed(1);
const stamp_path = archive => join(STAMP_DIR, archive.name + ".json");

function parse_args(argv) {
    const profiles = [];
    let force = false;
    for(const arg of argv) {
        if(arg === "--force" || arg === "-f") force = true;
        else if(arg === "--help" || arg === "-h") { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 4).map(line => line.slice(3)).join("\n")); process.exit(0); }
        else if(arg.startsWith("-")) throw new UserError(`unknown option ${arg}`);
        else profiles.push(arg);
    }
    return { profiles, force };
}

function select_archives(profiles) {
    const known = [...new Set(manifest.archives.map(a => a.profile))].filter(name => name !== COMMON);
    for(const name of profiles) {
        if(name !== COMMON && !known.includes(name)) throw new UserError(`unknown profile "${name}"; available: ${known.join(", ")}`);
    }
    if(profiles.length === 0) return manifest.archives;
    return manifest.archives.filter(a => a.profile === COMMON || profiles.includes(a.profile));
}

function up_to_date(archive) {
    if(!existsSync(stamp_path(archive))) return false;
    try {
        const stamp = JSON.parse(readFileSync(stamp_path(archive), "utf8"));
        return stamp.sha256 === archive.sha256 && archive.provides.every(entry => existsSync(join(IMAGES_DIR, entry)));
    }
    catch { return false; }
}

function base_location() {
    const base = process.env.LAPLACE_IMAGES_URL || default_base;
    if(/^https?:\/\//.test(base)) return { url: base.replace(/\/+$/, "") };
    const local = base.startsWith("file://") ? fileURLToPath(base) : base.replace(/^~(?=\/|$)/, homedir());
    return { dir: resolve(local) };
}

function progress_line(label, done, total, started) {
    const speed = done / Math.max((Date.now() - started) / 1000, 0.001) / MB;
    const percent = total ? ` ${String(Math.floor((done / total) * 100)).padStart(3)}%` : "";
    const line = `  ${label}  ${mb(done)}${total ? "/" + mb(total) : ""} MB${percent}  ${speed.toFixed(1)} MB/s`;
    if(process.stdout.isTTY) process.stdout.write("\r" + line.padEnd(process.stdout.columns ? process.stdout.columns - 1 : 78));
    return line;
}

// Passes the bytes through, hashing them and printing one progress line.
function meter(label, total) {
    const hash = createHash("sha256");
    const started = Date.now();
    let done = 0, last = 0;
    const stream = new Transform({
        transform(chunk, _enc, cb) {
            hash.update(chunk);
            done += chunk.length;
            if(Date.now() - last > PROGRESS_INTERVAL_MS) { last = Date.now(); progress_line(label, done, total, started); }
            cb(null, chunk);
        },
    });
    stream.finish_line = () => { const line = progress_line(label, done, total, started); if(process.stdout.isTTY) process.stdout.write("\n"); else console.log(line); };
    stream.digest = () => hash.digest("hex");
    stream.bytes = () => done;
    return stream;
}

function network_error(url, error) {
    const code = error.cause?.code ?? error.code;
    const hint = "check the connection, or point LAPLACE_IMAGES_URL at a directory with the archives";
    return new UserError(`cannot reach ${url}${code ? ` (${code})` : ""}: ${hint}`);
}

async function open_source(archive, location) {
    if(location.dir) {
        const file = join(location.dir, archive.name);
        if(!existsSync(file)) throw new UserError(`${file} does not exist`);
        return { stream: createReadStream(file), file, total: archive.size };
    }
    const url = `${location.url}/${archive.name}`;
    let response;
    try { response = await fetch(url); }
    catch(error) { throw network_error(url, error); }
    if(response.status === 404) throw new UserError(`${url} was not found (HTTP 404); the release ${manifest.tag} may not be published yet`);
    if(!response.ok) throw new UserError(`${url} answered HTTP ${response.status}`);
    return { stream: Readable.fromWeb(response.body), url, total: Number(response.headers.get("content-length")) || archive.size };
}

function check_disk_space(archive, location) {
    mkdirSync(IMAGES_DIR, { recursive: true });
    const { bavail, bsize } = statfsSync(IMAGES_DIR);
    const free = bavail * bsize;
    const need = Math.ceil((archive.unpacked + (location.dir ? 0 : archive.size)) * 1.05);
    if(free < need) throw new UserError(`not enough disk space for ${archive.name}: about ${mb(need)} MB needed, ${mb(free)} MB free in ${IMAGES_DIR}`);
}

// Downloads (or reads) the archive and returns the path of a verified file.
async function fetch_archive(archive, location) {
    const { stream, file, total } = await open_source(archive, location);
    const meter_stream = meter(archive.name, total);
    const part = file ?? join(WORK_DIR, archive.name + ".part");
    const sink = file ? new Writable({ write: (_chunk, _enc, cb) => cb() }) : createWriteStream(part);
    try { await pipeline(stream, meter_stream, sink); }
    catch(error) {
        if(!file) rmSync(part, { force: true });
        if(error.code === "ENOSPC") throw new UserError(`no space left on the disk while writing ${part}`);
        if(file) throw error;
        throw new UserError(`download of ${archive.name} failed: ${error.message}`);
    }
    meter_stream.finish_line();
    const digest = meter_stream.digest();
    if(digest !== archive.sha256) {
        if(!file) rmSync(part, { force: true });
        throw new UserError(`${archive.name}: sha256 mismatch (expected ${archive.sha256}, got ${digest}); the file is damaged or the release was replaced`);
    }
    return part;
}

async function unpack(archive, file) {
    let tar;
    try { tar = await import("tar"); }
    catch { throw new UserError('the "tar" package is not installed; run `npm ci` in the repository root first'); }
    const target = join(WORK_DIR, "unpack-" + archive.name);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    let entries = 0;
    const started = Date.now();
    try {
        await tar.x({ file, cwd: target, onReadEntry: () => { entries += 1; if(process.stdout.isTTY && entries % 200 === 0) process.stdout.write(`\r  unpacking ${archive.name}  ${entries} files  ${((Date.now() - started) / 1000).toFixed(0)} s`.padEnd(78)); } });
    }
    catch(error) {
        if(error.code === "ENOSPC") throw new UserError(`no space left on the disk while unpacking ${archive.name}`);
        throw new UserError(`cannot unpack ${archive.name}: ${error.message}`);
    }
    if(process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(78) + "\r");
    for(const entry of archive.provides) {
        if(!existsSync(join(target, entry))) throw new UserError(`${archive.name} does not contain ${entry}`);
        rmSync(join(IMAGES_DIR, entry), { recursive: true, force: true });
        renameSync(join(target, entry), join(IMAGES_DIR, entry));
    }
    rmSync(target, { recursive: true, force: true });
    mkdirSync(STAMP_DIR, { recursive: true });
    writeFileSync(stamp_path(archive), JSON.stringify({ sha256: archive.sha256, provides: archive.provides }) + "\n");
    console.log(`  ${archive.name}: ${entries} files unpacked into images/`);
}

async function main() {
    const { profiles, force } = parse_args(process.argv.slice(2));
    const archives = select_archives(profiles);
    const pending = archives.filter(archive => force || !up_to_date(archive));
    if(pending.length === 0) { console.log("images are up to date"); return; }
    const location = base_location();
    console.log(`source: ${location.url ?? location.dir}`);
    mkdirSync(WORK_DIR, { recursive: true });
    for(const archive of pending) {
        check_disk_space(archive, location);
        const file = await fetch_archive(archive, location);
        try { await unpack(archive, file); }
        finally { if(!location.dir) rmSync(file, { force: true }); }
    }
    rmSync(WORK_DIR, { recursive: true, force: true });
    console.log(`done: ${pending.length} archive(s) installed, ${archives.length - pending.length} already up to date`);
}

main().catch(error => {
    console.error(error instanceof UserError ? `error: ${error.message}` : error);
    process.exit(1);
});
