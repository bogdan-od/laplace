// Compares two v86 device states (ArrayBuffer from save_state): returns
// the paths in the state tree where values or buffers differ. A snapshot taken right
// after a restore must match the restored one; a difference points to the device
// whose set_state does not restore everything get_state saved.
const HEADER_BYTES = 16;
const INFO_LENGTH_WORD = 3;
const SHOWN_BYTES = 8;

function parse_state(buffer) {
    const info_length = new Uint32Array(buffer.slice(0, HEADER_BYTES))[INFO_LENGTH_WORD];
    const info = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, HEADER_BYTES, info_length)));
    const buffers_at = HEADER_BYTES + info_length + 3 & ~3;
    const bytes = new Uint8Array(buffer);
    const buffer_of = ref => {
        const { offset, length } = info.buffer_infos[ref.buffer_id];
        return bytes.subarray(buffers_at + offset, buffers_at + offset + length);
    };
    return { tree: info.state, buffer_of };
}

function diff_buffers(x, y, path) {
    if(x.length !== y.length) return [`${path}: buffer length ${x.length} != ${y.length}`];
    let count = 0, first = -1;
    for(let i = 0; i < x.length; i++) {
        if(x[i] === y[i]) continue;
        count++;
        if(first < 0) first = i;
    }
    if(!count) return [];
    const shown = bytes => [...bytes.subarray(first, first + SHOWN_BYTES)].join(",");
    return [`${path}: in the buffer (${x.length} B) differ ${count} B, first at ${first}: ${shown(x)} != ${shown(y)}`];
}

function diff_nodes(a, b, path, A, B) {
    const both_objects = a !== null && b !== null && typeof a === "object" && typeof b === "object";
    if(!both_objects) return a === b ? [] : [`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
    if("buffer_id" in a && "buffer_id" in b) return diff_buffers(A.buffer_of(a), B.buffer_of(b), path);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap(key => diff_nodes(a[key], b[key], `${path}/${key}`, A, B));
}

export function state_diff(expected, actual) {
    const A = parse_state(expected), B = parse_state(actual);
    return diff_nodes(A.tree, B.tree, "", A, B);
}
