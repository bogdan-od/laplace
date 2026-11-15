export const MIN_FRAME_LEN: number;
export const MAX_FRAME_LEN: number;

export function frame_ok(frame: Uint8Array): boolean;
/** MAC key of a frame, "aa:bb:cc:dd:ee:ff"; offset 0 is the destination, 6 is the source. */
export function mac_key(frame: Uint8Array, offset: number): string;
