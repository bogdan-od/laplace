// Packs the contents of images/ into the release archives and writes images.json (name, size, sha256 per archive).
//   node scripts/pack-images.mjs [output-dir]     default: release/images-<tag>/ next to the repository
// The archives are reproducible: sorted entries, zero timestamps and owners. Upload the files to the GitHub release
// named in images.json; `npm run images` downloads them from there.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "tar";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const IMAGES_DIR = join(ROOT, "images");
const REPOSITORY = "bogdan-od/laplace";
const TAG = "images-v1";
const GZIP_LEVEL = 9;
// What every archive holds, relative to images/. `common` is installed together with any profile.
const LAYOUT = {
    common: ["v86.wasm", "seabios.bin", "vgabios.bin"],
    buildroot: ["buildroot-bzimage68.bin", "buildroot-boot.snap"],
    net: ["net-bzimage.bin", "net-boot.snap"],
    alpine: ["alpine-fs.json", "alpine-rootfs-flat", "alpine-boot.snap"],
    study: ["study-fs.json", "study-rootfs-flat", "study-boot.snap"],
};

function list_files(entry) {
    const path = join(IMAGES_DIR, entry);
    if(!statSync(path).isDirectory()) return [entry];
    return readdirSync(path).sort().flatMap(name => list_files(join(entry, name)));
}

async function pack(profile, out_dir) {
    const files = LAYOUT[profile].flatMap(list_files).sort();
    const name = `${profile}.tar.gz`;
    const file = join(out_dir, name);
    await create({ file, cwd: IMAGES_DIR, gzip: { level: GZIP_LEVEL }, portable: true, mtime: new Date(0), noDirRecurse: true }, files);
    const unpacked = files.reduce((sum, f) => sum + statSync(join(IMAGES_DIR, f)).size, 0);
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    console.log(`${name}: ${files.length} files, ${statSync(file).size} bytes`);
    return { name, profile, size: statSync(file).size, unpacked, sha256, provides: LAYOUT[profile] };
}

const out_dir = resolve(process.argv[2] ?? join(ROOT, "..", "laplace-release", TAG));
mkdirSync(out_dir, { recursive: true });
const archives = [];
for(const profile of Object.keys(LAYOUT)) archives.push(await pack(profile, out_dir));
writeFileSync(join(ROOT, "images.json"), JSON.stringify({ tag: TAG, repository: REPOSITORY, archives }, null, 2) + "\n");
console.log(`images.json written; upload ${out_dir}/*.tar.gz to the release ${TAG}`);
