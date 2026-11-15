// A journal's incoming Ethernet frames as a libpcap file (tcpdump, Wireshark). Pure: no DOM, no network.
// A `net` event of a journal is a frame that arrived at the journal's machine (the engine records the frame and
// hands it to the machine in the same step), so the file holds the frames received by the machine.

import { event_times, type Journal } from "@core/core/journal.mjs";

type JournalLike = Pick<Journal, "header" | "events">;

const MAGIC = 0xa1b2c3d4;
const VERSION_MAJOR = 2;
const VERSION_MINOR = 4;
const SNAPLEN = 65535;
const LINKTYPE_ETHERNET = 1;
const GLOBAL_HEADER_BYTES = 24;
const RECORD_HEADER_BYTES = 16;
const US_PER_MS = 1000;
const US_PER_S = 1_000_000;

/** A journal belongs to one machine (`header.machine`); a journal without a name is taken as the machine's. */
function ownedBy(journal: JournalLike, machine: string): boolean {
  return journal.header.machine === undefined || journal.header.machine === machine;
}

/** How many frames `buildPcap` writes: a button asks before it builds the file. */
export function countNetFrames(journal: JournalLike, machine: string): number {
  if (!ownedBy(journal, machine)) return 0;
  return journal.events.reduce((count, event) => count + (event.t === "net" ? 1 : 0), 0);
}

/** The pcap button is shown only when there is a frame to save; while the count is unknown or zero it is not on the page. */
export function hasNetFrames(frames: number | null): frames is number {
  return frames !== null && frames > 0;
}

function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export function buildPcap(journal: JournalLike, machine: string): Uint8Array {
  const frames: { stamp_us: number; bytes: Uint8Array }[] = [];
  if (ownedBy(journal, machine)) {
    const times = event_times(journal);
    const epoch = journal.header.epoch ?? 0;
    journal.events.forEach((event, index) => {
      if (event.t !== "net") return;
      frames.push({ stamp_us: Math.round((epoch + (times[index] ?? 0)) * US_PER_MS), bytes: decodeBase64(event.data) });
    });
  }

  const total = frames.reduce((sum, frame) => sum + RECORD_HEADER_BYTES + Math.min(frame.bytes.length, SNAPLEN), GLOBAL_HEADER_BYTES);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION_MAJOR, true);
  view.setUint16(6, VERSION_MINOR, true);
  // Bytes 8..15 (time zone, accuracy) stay 0.
  view.setUint32(16, SNAPLEN, true);
  view.setUint32(20, LINKTYPE_ETHERNET, true);

  let at = GLOBAL_HEADER_BYTES;
  for (const frame of frames) {
    const kept = Math.min(frame.bytes.length, SNAPLEN);
    view.setUint32(at, Math.floor(frame.stamp_us / US_PER_S), true);
    view.setUint32(at + 4, frame.stamp_us % US_PER_S, true);
    view.setUint32(at + 8, kept, true);
    view.setUint32(at + 12, frame.bytes.length, true);
    out.set(frame.bytes.subarray(0, kept), at + RECORD_HEADER_BYTES);
    at += RECORD_HEADER_BYTES + kept;
  }
  return out;
}
