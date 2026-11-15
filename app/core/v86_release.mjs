// v86 built from source defaults to DEBUG = true (every dbg_assert is live).
// log.js reads the global when it loads; engine.mjs imports this module first,
// and ES modules evaluate in import order, so the flag is set before v86 loads.
globalThis.DEBUG = false;
