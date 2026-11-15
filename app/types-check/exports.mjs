// Compares the runtime exports of each module with the value exports declared in its .d.mts.
// Types (interface, type) have no runtime counterpart and are skipped. Every module is imported in its own child
// process: some of them replace globals on import or expect a browser. A module that cannot be imported in Node
// is compared through `grep '^export'` of its source instead.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = [
    "core/journal", "core/digest", "core/snapfile", "core/host_nan", "core/engine",
    "machine/machine", "machine/agent_channel", "machine/worker",
    "net/topology", "net/topology_journals", "net/switch", "net/mesh", "net/room", "net/relay", "net/router",
    "net/frame", "net/mac", "net/base64", "net/backoff", "net/config", "net/room_fields",
    "profiles", "ui/lesson_run",
];
// Declared-only files: they describe messages and have no .mjs counterpart.
const TYPES_ONLY = ["machine/worker_protocol"];
const VALUE_DECLARATION = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)/;
const SOURCE_DECLARATION = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)/;
const SOURCE_LIST = /^export\s*\{([^}]*)\}/;

const names_in = (text, pattern) => text.split("\n").flatMap(line => {
    const match = pattern.exec(line);
    return match ? [match[1]] : [];
});

function declared_names(base) {
    const file = join(APP, `${base}.d.mts`);
    if(!existsSync(file)) return null;
    return names_in(readFileSync(file, "utf8"), VALUE_DECLARATION).sort();
}

function source_names(base) {
    const text = readFileSync(join(APP, `${base}.mjs`), "utf8");
    const listed = text.split("\n").flatMap(line => {
        const match = SOURCE_LIST.exec(line);
        return match ? match[1].split(",").map(name => name.trim().split(/\s+as\s+/).pop()).filter(Boolean) : [];
    });
    return [...names_in(text, SOURCE_DECLARATION), ...listed].sort();
}

function imported_names(base) {
    const url = pathToFileURL(join(APP, `${base}.mjs`)).href;
    const script = `import(${JSON.stringify(url)}).then(m => console.log(JSON.stringify(Object.keys(m))))`;
    try {
        const output = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
        return { names: JSON.parse(output.trim().split("\n").pop()).sort(), how: "import" };
    }
    catch (error) {
        const reason = String(error.stderr ?? error.message).trim().split("\n")[0];
        return { names: source_names(base), how: `grep (import failed: ${reason})` };
    }
}

let problems = 0;
const report = text => { problems++; console.log(text); };

for(const base of MODULES) {
    const declared = declared_names(base);
    const { names, how } = imported_names(base);
    if(declared === null) {
        if(names.length > 0) report(`${base}: no .d.mts, but the module exports ${names.join(", ")}`);
        else console.log(`${base}: no exports, no .d.mts (ok)`);
        continue;
    }
    const missing = names.filter(name => !declared.includes(name));
    const extra = declared.filter(name => !names.includes(name));
    if(missing.length > 0) report(`${base}: exported but not declared: ${missing.join(", ")}`);
    if(extra.length > 0) report(`${base}: declared but not exported: ${extra.join(", ")}`);
    if(missing.length === 0 && extra.length === 0) console.log(`${base}: ${names.length} names match [${how}]`);
}

for(const base of TYPES_ONLY) {
    const declared = declared_names(base);
    if(declared === null) report(`${base}: .d.mts is missing`);
    else if(declared.length > 0) report(`${base}: types-only file declares values: ${declared.join(", ")}`);
    else console.log(`${base}: types only (ok)`);
}

console.log(problems === 0 ? "mismatches: 0" : `mismatches: ${problems}`);
process.exitCode = problems === 0 ? 0 : 1;
