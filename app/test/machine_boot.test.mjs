// A journal that starts from the boot snapshot replays from the first event, whatever `next` the snapshot records
// (12 in net-boot.snap, 834 in study-boot.snap).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { Machine } from "../machine/machine.mjs";

const ROOT = new URL("../../", import.meta.url);

for(const profile of ["net", "study", "buildroot", "alpine"]) {
    test(`boot snapshot ${profile} gives next 0`, async () => {
        const bytes = fs.readFileSync(new URL(`images/${profile}-boot.snap`, ROOT));
        const fetch_before = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
        try {
            const machine = new Machine({ profile, root: "../", name: "t" });
            machine.abs = "http://localhost/app/";
            machine.profile_name = profile;
            await machine.load_boot();
            assert.equal(machine.boot.next, 0);
        }
        finally { globalThis.fetch = fetch_before; }
    });
}
