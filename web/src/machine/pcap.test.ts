import type { Journal } from "@core/core/journal.mjs";
import { describe, expect, it } from "vitest";
import { buildPcap, countNetFrames, hasNetFrames } from "./pcap";

const EPOCH = 1_700_000_000_000; // 0x6553F100 s

function journal(machine: string | undefined, events: Journal["events"]): Journal {
  return { header: { format: "v86-replay/9", profile: "buildroot", seed: 1, epoch: EPOCH, ...(machine === undefined ? {} : { machine }) }, events };
}

const FRAME_A = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03];
const FRAME_B = [0xff, 0x00];
const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

const events: Journal["events"] = [
  { t: "serial", c: 0, w: 500, data: "x" },
  { t: "net", c: 0, w: 1500, data: base64(FRAME_A) },
  { t: "net", c: 0, w: 2500.25, data: base64(FRAME_B) },
];

// Written out by hand: the global header, then per frame a record header (seconds, microseconds, kept, real length) and the data.
const EXPECTED = Uint8Array.from([
  0xd4, 0xc3, 0xb2, 0xa1, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x01, 0xf1, 0x53, 0x65, 0x20, 0xa1, 0x07, 0x00, 0x07, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, ...FRAME_A,
  0x02, 0xf1, 0x53, 0x65, 0x1a, 0xa2, 0x07, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, ...FRAME_B,
]);

describe("buildPcap", () => {
  it("writes the frames of the machine as a little-endian libpcap file", () => {
    expect(Array.from(buildPcap(journal("m1", events), "m1"))).toEqual(Array.from(EXPECTED));
  });

  it("writes only the global header for a journal without frames", () => {
    const out = buildPcap(journal("m1", [{ t: "serial", c: 0, w: 1, data: "x" }]), "m1");
    expect(Array.from(out)).toEqual(Array.from(EXPECTED.subarray(0, 24)));
    expect(Array.from(buildPcap(journal("m1", []), "m1"))).toEqual(Array.from(EXPECTED.subarray(0, 24)));
  });

  it("leaves out the frames of a journal of another machine", () => {
    const other = journal("m2", events);
    expect(buildPcap(other, "m1").length).toBe(24);
    expect(countNetFrames(other, "m1")).toBe(0);
  });

  it("takes a journal without a machine name as the machine's", () => {
    expect(countNetFrames(journal(undefined, events), "m1")).toBe(2);
  });

  it("counts the frames it writes", () => {
    expect(countNetFrames(journal("m1", events), "m1")).toBe(2);
  });
});

describe("hasNetFrames", () => {
  it("is true only for a known positive count", () => {
    expect([null, 0, 1, 40].map(hasNetFrames)).toEqual([false, false, true, true]);
  });
});
