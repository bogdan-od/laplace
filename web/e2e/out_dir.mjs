// Output directory for screenshots and failure dumps of the browser scripts: `out/e2e/<name>` at the repository root,
// or `$E2E_OUT/<name>`.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const out_dir = name => join(process.env.E2E_OUT ?? join(ROOT, "out", "e2e"), name);
