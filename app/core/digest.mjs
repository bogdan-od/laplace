// Fast 64-bit content hash, identical in Node and browsers (no crypto API).
// Two independent 32-bit lanes (murmur3 and xxhash32 rounds) over
// little-endian words; it detects accidental changes, not adversarial ones.

export const CHUNK = 65536;

const M1 = 0xcc9e2d51, M2 = 0x1b873593, M3 = 0xe6546b64;
const X1 = 0x9e3779b1, X2 = 0x85ebca77;

const rotl = (x, r) => (x << r) | (x >>> (32 - r));

function fmix(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}

const hex8 = x => x.toString(16).padStart(8, "0");

function hash_words(words, tail, length) {
    let a = 0x2545f491, b = 0x6a09e667;
    const n = words.length;
    for(let i = 0; i < n; i++) {
        const w = words[i];
        let k = Math.imul(w, M1); k = rotl(k, 15); k = Math.imul(k, M2);
        a ^= k; a = rotl(a, 13); a = (Math.imul(a, 5) + M3) | 0;
        b = Math.imul(rotl((b + Math.imul(w, X2)) | 0, 13), X1);
    }
    if(tail !== null) {
        let k = Math.imul(tail, M1); k = rotl(k, 15); a ^= Math.imul(k, M2);
        b = Math.imul(rotl((b + Math.imul(tail, X2)) | 0, 13), X1);
    }
    return hex8(fmix(a ^ length)) + hex8(fmix(b ^ Math.imul(length, X1)));
}

// 16 hex characters.
export function hash_bytes(bytes) {
    const n = bytes.length >>> 2;
    const aligned = (bytes.byteOffset & 3) === 0;
    const words = aligned ? new Uint32Array(bytes.buffer, bytes.byteOffset, n) : new Uint32Array(bytes.slice(0, n * 4).buffer);
    let tail = null;
    if(bytes.length & 3) {
        tail = 0;
        for(let i = n * 4, s = 0; i < bytes.length; i++, s += 8) tail |= bytes[i] << s;
    }
    return hash_words(words, tail, bytes.length);
}

export const hash_text = text => hash_bytes(new TextEncoder().encode(text));

// Hash of every CHUNK-sized piece; the last piece may be shorter.
export function chunk_hashes(bytes) {
    const out = [];
    for(let at = 0; at < bytes.length; at += CHUNK) out.push(hash_bytes(bytes.subarray(at, at + CHUNK)));
    return out;
}

export const digest_of_hashes = hashes => hash_text(hashes.join(""));
