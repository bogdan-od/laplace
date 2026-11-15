// Ethernet frame without FCS: 14-byte header, up to 1500 bytes of data, plus a VLAN tag (4 bytes) in a tagged frame.
export const MIN_FRAME_LEN = 14;
export const MAX_FRAME_LEN = 1522;

// A frame from outside (a neighbour, the relay, another port) that does not fit these bounds does not reach the
// machine.
export const frame_ok = frame => frame.length >= MIN_FRAME_LEN && frame.length <= MAX_FRAME_LEN;

// MAC key of a frame: "aa:bb:cc:dd:ee:ff"; offset 0 is the destination, 6 is the source.
export function mac_key(frame, offset) {
    return Array.from(frame.subarray(offset, offset + 6), byte => byte.toString(16).padStart(2, "0")).join(":");
}
