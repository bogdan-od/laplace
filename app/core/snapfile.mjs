// Snapshot as one gzip file and back. Layout before compression:
// "V86SNAP1" | u32le header length | header JSON | state bytes | blobs.
// Blobs are content-addressed pieces of wasm memory and JIT modules, each
// stored once however many times its hash appears.
import { CHUNK } from "./digest.mjs";

const MAGIC = "V86SNAP1";
const SNAP_FORMAT = "v86-snap/1";
const PREFIX = MAGIC.length + 4;

async function pipe(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// snap: engine snapshot {clock, state, mem_size, chunks: [[h, bytes|null]], jit: [[index, h, bytes|null]]};
// lookup(h) supplies the bytes the engine did not resend.
export function materialize(snap, lookup = () => null) {
    const own = new Map();
    for(const [h, b] of snap.chunks) if(b) own.set(h, b);
    for(const [, h, b] of snap.jit) if(b) own.set(h, b);
    const blob = h => {
        const b = own.get(h) || lookup(h);
        if(!b) throw new Error(`знімок неповний: немає шматка ${h}`);
        return b;
    };
    const mem = new Uint8Array(snap.mem_size);
    snap.chunks.forEach(([h], i) => mem.set(blob(h), i * CHUNK));
    return {
        clock: snap.clock, state: snap.state, mem,
        jit: snap.jit.map(([index, h]) => [index, blob(h)]),
        hashes: [...snap.chunks.map(([h]) => h), ...snap.jit.map(([, h]) => h)],
        blob,
    };
}

export async function encode_snapshot(snap, lookup) {
    const full = materialize(snap, lookup);
    const blobs = new Map();
    for(const h of full.hashes) if(!blobs.has(h)) blobs.set(h, full.blob(h));
    const state = new Uint8Array(snap.state);
    const table = [];
    let size = state.length;
    for(const [h, b] of blobs) { table.push([h, size, b.length]); size += b.length; }
    const header = new TextEncoder().encode(JSON.stringify({
        format: SNAP_FORMAT, clock: snap.clock, mem_size: snap.mem_size, state_len: state.length,
        chunks: snap.chunks.map(([h]) => h), jit: snap.jit.map(([index, h]) => [index, h]), blobs: table,
    }));
    const out = new Uint8Array(PREFIX + header.length + size);
    out.set(new TextEncoder().encode(MAGIC), 0);
    new DataView(out.buffer).setUint32(MAGIC.length, header.length, true);
    const body = PREFIX + header.length;
    out.set(header, PREFIX);
    out.set(state, body);
    for(const [h, at] of table) out.set(blobs.get(h), body + at);
    return pipe(out, new CompressionStream("gzip"));
}

// → engine-shaped snap {clock, state, mem_size, chunks: [[h, bytes]], jit: [[index, h, bytes]]}; bytes are views into one buffer.
export async function read_snapshot(gz) {
    const raw = await pipe(gz, new DecompressionStream("gzip"));
    if(new TextDecoder().decode(raw.subarray(0, MAGIC.length)) !== MAGIC) throw new Error("це не файл знімка v86-replay");
    const header_len = new DataView(raw.buffer, raw.byteOffset).getUint32(MAGIC.length, true);
    const header = JSON.parse(new TextDecoder().decode(raw.subarray(PREFIX, PREFIX + header_len)));
    if(header.format !== SNAP_FORMAT) throw new Error(`знімок формату ${header.format}, потрібен ${SNAP_FORMAT}`);
    const body = PREFIX + header_len;
    const state = raw.slice(body, body + header.state_len).buffer;
    const blobs = new Map(header.blobs.map(([h, at, len]) => [h, raw.subarray(body + at, body + at + len)]));
    return {
        clock: header.clock, state, mem_size: header.mem_size,
        chunks: header.chunks.map(h => [h, blobs.get(h)]),
        jit: header.jit.map(([index, h]) => [index, h, blobs.get(h)]),
    };
}

// → {clock, state: ArrayBuffer, mem: Uint8Array, jit: [[index, Uint8Array]], hashes, blob}
export async function decode_snapshot(gz) {
    return materialize(await read_snapshot(gz));
}
