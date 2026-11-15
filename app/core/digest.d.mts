export const CHUNK: number;

/** 16 hex digits. */
export function hash_bytes(bytes: Uint8Array): string;
export function hash_text(text: string): string;
/** Hash of every `CHUNK`-sized piece; the last piece may be shorter. */
export function chunk_hashes(bytes: Uint8Array): string[];
export function digest_of_hashes(hashes: readonly string[]): string;
