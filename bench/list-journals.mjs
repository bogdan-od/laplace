// Prints the paths of format /9 (machine) journals, marking whether the image snapshot matches (digest). stdout:
// path<TAB>profile<TAB>ok|old_image
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode_snapshot } from "../app/core/snapfile.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") + "/";
const digests = {};
for(const name of ["buildroot", "net", "alpine", "study"]) digests[name] = (await decode_snapshot(new Uint8Array(fs.readFileSync(`${ROOT}images/${name}-boot.snap`)))).clock.ram;
for(const dir of ["server/demo/journals", "app/data/journals"]) {
    if(!fs.existsSync(ROOT + dir)) continue;
    for(const f of fs.readdirSync(ROOT + dir).sort()) {
        const j = JSON.parse(fs.readFileSync(ROOT + dir + "/" + f, "utf8"));
        if(j.header?.format !== "v86-replay/9") continue;
        console.log([dir + "/" + f, j.header.profile, j.header.start?.digest === digests[j.header.profile] ? "ok" : "old_image"].join("\t"));
    }
}
