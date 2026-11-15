/** NaN sign of 0.0/0.0 in wasm on the host: `neg` is bits ffc00000 (x86), `pos` is 7fc00000 (ARM). */
export type HostNanSign = "neg" | "pos";

export const HOST_NAN_SIGNS: readonly ["neg", "pos"];

/** Computed once and cached. */
export function host_nan(): HostNanSign;
