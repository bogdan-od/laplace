import { describe, expect, it } from "vitest";
import { DAMAGED_TEXT, parseFrame } from "./frames";

const MAC_A = [0x02, 0, 0, 0, 0, 0x0a];
const MAC_B = [0x02, 0, 0, 0, 0, 0x0b];
const BROADCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const IP_A = [10, 0, 10, 2];
const IP_B = [10, 0, 10, 3];

const be16 = (value: number): number[] => [value >> 8, value & 0xff];
const bytes = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());

function ethernet(dst: number[], src: number[], ethertype: number, payload: number[], vlan?: number): Uint8Array {
  return bytes(dst, src, vlan === undefined ? [] : [...be16(0x8100), ...be16(vlan)], be16(ethertype), payload);
}

function arpPayload(op: number, senderMac: number[], senderIp: number[], targetMac: number[], targetIp: number[]): number[] {
  return [...be16(1), ...be16(0x0800), 6, 4, ...be16(op), ...senderMac, ...senderIp, ...targetMac, ...targetIp];
}

function ipv4(proto: number, src: number[], dst: number[], payload: number[], header = 20): number[] {
  const head = [0x40 | (header / 4), 0, ...be16(header + payload.length), 0, 0, 0, 0, 64, proto, 0, 0, ...src, ...dst];
  return [...head, ...new Array<number>(header - head.length).fill(0), ...payload];
}

describe("parseFrame", () => {
  it("reads an ARP request", () => {
    const frame = ethernet(BROADCAST, MAC_A, 0x0806, arpPayload(1, MAC_A, IP_A, [0, 0, 0, 0, 0, 0], IP_B));
    expect(parseFrame(frame)).toMatchObject({
      damaged: false,
      src: "02:00:00:00:00:0a",
      dst: "ff:ff:ff:ff:ff:ff",
      vlan: null,
      ethertype: 0x0806,
      protocol: "ARP",
      summary: "ARP who-has 10.0.10.3 tell 10.0.10.2",
    });
  });

  it("reads an ARP reply with the MAC in the answer", () => {
    const frame = ethernet(MAC_A, MAC_B, 0x0806, arpPayload(2, MAC_B, IP_B, MAC_A, IP_A));
    expect(parseFrame(frame)).toMatchObject({ protocol: "ARP", summary: "ARP 10.0.10.3 is-at 02:00:00:00:00:0b" });
  });

  it("reads an ICMP echo request and a reply", () => {
    const request = ethernet(MAC_B, MAC_A, 0x0800, ipv4(1, IP_A, IP_B, [8, 0, 0, 0, 0x12, 0x34, 0, 7]));
    expect(parseFrame(request)).toMatchObject({ protocol: "ICMP", summary: "ICMP echo request 10.0.10.2 > 10.0.10.3, id 4660, seq 7" });
    const reply = ethernet(MAC_A, MAC_B, 0x0800, ipv4(1, IP_B, IP_A, [0, 0, 0, 0, 0x12, 0x34, 0, 7]));
    expect(parseFrame(reply).summary).toBe("ICMP echo reply 10.0.10.3 > 10.0.10.2, id 4660, seq 7");
  });

  it("reads a TCP SYN with ports and flags, and SYN+ACK", () => {
    const tcp = (flags: number) => [...be16(49152), ...be16(80), 0, 0, 0, 1, 0, 0, 0, 0, 0x50, flags, ...be16(1024), 0, 0, 0, 0];
    const syn = ethernet(MAC_B, MAC_A, 0x0800, ipv4(6, IP_A, IP_B, tcp(0x02)));
    expect(parseFrame(syn)).toMatchObject({ protocol: "TCP", summary: "TCP 10.0.10.2:49152 > 10.0.10.3:80 [SYN]" });
    expect(parseFrame(ethernet(MAC_A, MAC_B, 0x0800, ipv4(6, IP_B, IP_A, tcp(0x12)))).summary).toContain("[SYN,ACK]");
  });

  it("reads UDP ports and honours the IPv4 header length", () => {
    const payload = [...be16(5353), ...be16(53), ...be16(8), 0, 0];
    const frame = ethernet(MAC_B, MAC_A, 0x0800, ipv4(17, IP_A, IP_B, payload, 24));
    expect(parseFrame(frame)).toMatchObject({ protocol: "UDP", summary: "UDP 10.0.10.2:5353 > 10.0.10.3:53" });
  });

  it("reads the 802.1Q tag and the protocol behind it", () => {
    const frame = ethernet(BROADCAST, MAC_A, 0x0806, arpPayload(1, MAC_A, IP_A, [0, 0, 0, 0, 0, 0], IP_B), 0x2005);
    expect(parseFrame(frame)).toMatchObject({ vlan: 5, ethertype: 0x0806, protocol: "ARP", damaged: false });
  });

  it("names the EtherType of an unknown protocol", () => {
    expect(parseFrame(ethernet(MAC_B, MAC_A, 0x88cc, [1, 2, 3]))).toMatchObject({ protocol: "other", summary: "EtherType 0x88cc" });
    expect(parseFrame(ethernet(MAC_B, MAC_A, 0x86dd, new Array<number>(40).fill(0))).protocol).toBe("IPv6");
  });

  it("returns a damaged frame instead of throwing for anything cut short", () => {
    const short = parseFrame(Uint8Array.from([1, 2, 3]));
    expect(short).toMatchObject({ damaged: true, protocol: "damaged", src: null, dst: null });
    expect(short.summary).toContain(DAMAGED_TEXT);
    expect(parseFrame(new Uint8Array(0)).damaged).toBe(true);

    const full = ethernet(MAC_B, MAC_A, 0x0800, ipv4(6, IP_A, IP_B, new Array<number>(20).fill(0)));
    for (let cut = 0; cut < full.length - 1; cut++) {
      const info = parseFrame(full.subarray(0, cut));
      if (cut < 14 + 20 + 20) expect(info.damaged, `cut at ${cut}`).toBe(true);
    }
    expect(parseFrame(ethernet(MAC_B, MAC_A, 0x0806, [0, 1, 8, 0])).summary).toContain(DAMAGED_TEXT);
    expect(parseFrame(bytes(MAC_B, MAC_A, [0x81, 0x00, 0x20])).damaged).toBe(true);
  });
});
