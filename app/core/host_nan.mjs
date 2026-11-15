// WebAssembly is deterministic in everything except NaN bits: the NaN sign is left to the host. v86 computes SSE with
// native wasm floats, so 0.0/0.0 in the guest gives ffc00000 on x86 and 7fc00000 on ARM, and the memory checksum
// rejects such a replay on another architecture. The host's sign goes into the journal header (`host_nan`). The module
// works in Node, in a page and in a Worker.
// (func (param f32 f32) (result i32) local.get 0 local.get 1 f32.div i32.reinterpret_f32)
const DIVIDE_BITS_MODULE = new Uint8Array([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    1, 7, 1, 0x60, 2, 0x7d, 0x7d, 1, 0x7f,
    3, 2, 1, 0,
    7, 5, 1, 1, 0x66, 0, 0,
    0x0a, 0x0a, 1, 8, 0, 0x20, 0, 0x20, 1, 0x95, 0xbc, 0x0b,
]);
const SIGN_BIT = 0x80000000;

export const HOST_NAN_SIGNS = ["neg", "pos"];

let cached = null;

// "neg": 0.0/0.0 gives bits ffc00000, "pos": 7fc00000. The operands are parameters rather than module constants,
// so that the compiler cannot fold the division.
export function host_nan() {
    if(cached === null) {
        const { f } = new WebAssembly.Instance(new WebAssembly.Module(DIVIDE_BITS_MODULE)).exports;
        const zero = 0;
        cached = (f(zero, zero) & SIGN_BIT) !== 0 ? "neg" : "pos";
    }
    return cached;
}
