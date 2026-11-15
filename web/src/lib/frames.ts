// A tcpdump-style reading of one Ethernet frame: Ethernet, 802.1Q tag, ARP, IPv4 with ICMP, TCP and UDP.
// A short or cut frame never throws: it comes back as damaged. Only the headers are read, so a frame that
// was cut after them (a capture of the first bytes) still reads fine.

export type FrameProtocol = "ARP" | "ICMP" | "TCP" | "UDP" | "IPv4" | "IPv6" | "other" | "damaged";

export interface FrameInfo {
  /** Bytes the parser was given. */
  length: number;
  damaged: boolean;
  /** MAC addresses `aa:bb:cc:dd:ee:ff`; null when the frame is shorter than the Ethernet header. */
  src: string | null;
  dst: string | null;
  /** 802.1Q tag; null when the frame has none. */
  vlan: number | null;
  /** The EtherType after the tag, if any; null when the frame is damaged before it. */
  ethertype: number | null;
  protocol: FrameProtocol;
  /** The tcpdump-style line without the link-layer addresses. */
  summary: string;
}

export const DAMAGED_TEXT = "Пошкоджений кадр";

const ETH_HEADER = 14;
const VLAN_TAG = 4;
const MAC_LEN = 6;
const ETHERTYPE_VLAN = 0x8100;
const ETHERTYPE_QINQ = 0x88a8;
const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_ARP = 0x0806;
const ETHERTYPE_IPV6 = 0x86dd;
const ARP_LEN = 28;
const ARP_REQUEST = 1;
const ARP_REPLY = 2;
const IPV4_MIN_HEADER = 20;
const IP_WORD = 4;
const FRAGMENT_OFFSET_MASK = 0x1fff;
const PROTO_ICMP = 1;
const PROTO_TCP = 6;
const PROTO_UDP = 17;
const ICMP_HEADER = 8;
const ICMP_ECHO_REPLY = 0;
const ICMP_ECHO_REQUEST = 8;
const TCP_MIN_HEADER = 20;
const UDP_HEADER = 8;
const TCP_FLAGS: readonly [number, string][] = [
  [0x02, "SYN"],
  [0x10, "ACK"],
  [0x01, "FIN"],
  [0x04, "RST"],
  [0x08, "PSH"],
  [0x20, "URG"],
];

function mac(bytes: Uint8Array, offset: number): string {
  return Array.from(bytes.subarray(offset, offset + MAC_LEN), (byte) => byte.toString(16).padStart(2, "0")).join(":");
}

function ipv4(bytes: Uint8Array, offset: number): string {
  return Array.from(bytes.subarray(offset, offset + IP_WORD)).join(".");
}

function u16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function hex4(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

type Payload = Pick<FrameInfo, "protocol" | "summary">;

function damaged(reason: string): Payload {
  return { protocol: "damaged", summary: `${DAMAGED_TEXT}: ${reason}` };
}

function arp(bytes: Uint8Array, at: number): Payload {
  if (bytes.length < at + ARP_LEN) return damaged("обрізаний ARP");
  const sender = ipv4(bytes, at + 14);
  const target = ipv4(bytes, at + 24);
  const op = u16(bytes, at + 6);
  if (op === ARP_REQUEST) return { protocol: "ARP", summary: `ARP who-has ${target} tell ${sender}` };
  if (op === ARP_REPLY) return { protocol: "ARP", summary: `ARP ${sender} is-at ${mac(bytes, at + 8)}` };
  return { protocol: "ARP", summary: `ARP op ${op} ${sender} > ${target}` };
}

function icmp(bytes: Uint8Array, at: number, route: string): Payload {
  if (bytes.length < at + ICMP_HEADER) return damaged("обрізаний ICMP");
  const type = bytes[at] ?? 0;
  const code = bytes[at + 1] ?? 0;
  const id = u16(bytes, at + 4);
  const seq = u16(bytes, at + 6);
  if (type === ICMP_ECHO_REQUEST) return { protocol: "ICMP", summary: `ICMP echo request ${route}, id ${id}, seq ${seq}` };
  if (type === ICMP_ECHO_REPLY) return { protocol: "ICMP", summary: `ICMP echo reply ${route}, id ${id}, seq ${seq}` };
  return { protocol: "ICMP", summary: `ICMP type ${type} code ${code} ${route}` };
}

function tcp(bytes: Uint8Array, at: number, src: string, dst: string): Payload {
  if (bytes.length < at + TCP_MIN_HEADER) return damaged("обрізаний TCP");
  const flags = bytes[at + 13] ?? 0;
  const names = TCP_FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
  const route = `${src}:${u16(bytes, at)} > ${dst}:${u16(bytes, at + 2)}`;
  return { protocol: "TCP", summary: `TCP ${route} [${names.join(",") || "."}]` };
}

function udp(bytes: Uint8Array, at: number, src: string, dst: string): Payload {
  if (bytes.length < at + UDP_HEADER) return damaged("обрізаний UDP");
  return { protocol: "UDP", summary: `UDP ${src}:${u16(bytes, at)} > ${dst}:${u16(bytes, at + 2)}` };
}

function ip(bytes: Uint8Array, at: number): Payload {
  if (bytes.length < at + IPV4_MIN_HEADER) return damaged("обрізаний IPv4");
  const header = ((bytes[at] ?? 0) & 0x0f) * IP_WORD;
  if (((bytes[at] ?? 0) >> 4) !== 4 || header < IPV4_MIN_HEADER) return damaged("неправильний заголовок IPv4");
  if (bytes.length < at + header) return damaged("обрізаний IPv4");
  const proto = bytes[at + 9] ?? 0;
  const src = ipv4(bytes, at + 12);
  const dst = ipv4(bytes, at + 16);
  const route = `${src} > ${dst}`;
  const next = at + header;
  if ((u16(bytes, at + 6) & FRAGMENT_OFFSET_MASK) !== 0) return { protocol: "IPv4", summary: `IPv4 фрагмент proto ${proto} ${route}` };
  if (proto === PROTO_ICMP) return icmp(bytes, next, route);
  if (proto === PROTO_TCP) return tcp(bytes, next, src, dst);
  if (proto === PROTO_UDP) return udp(bytes, next, src, dst);
  return { protocol: "IPv4", summary: `IPv4 proto ${proto} ${route}` };
}

/** Reads one frame; never throws. */
export function parseFrame(bytes: Uint8Array): FrameInfo {
  const length = bytes.length;
  if (length < ETH_HEADER) {
    return { length, damaged: true, src: null, dst: null, vlan: null, ethertype: null, protocol: "damaged", summary: `${DAMAGED_TEXT}: ${length} байт` };
  }
  const dst = mac(bytes, 0);
  const src = mac(bytes, MAC_LEN);
  let ethertype = u16(bytes, 12);
  let at = ETH_HEADER;
  let vlan: number | null = null;
  if (ethertype === ETHERTYPE_VLAN || ethertype === ETHERTYPE_QINQ) {
    if (length < ETH_HEADER + VLAN_TAG) {
      return { length, damaged: true, src, dst, vlan: null, ethertype: null, protocol: "damaged", summary: `${DAMAGED_TEXT}: обрізана мітка VLAN` };
    }
    vlan = u16(bytes, 14) & 0x0fff;
    ethertype = u16(bytes, 16);
    at = ETH_HEADER + VLAN_TAG;
  }
  let payload: Payload;
  if (ethertype === ETHERTYPE_ARP) payload = arp(bytes, at);
  else if (ethertype === ETHERTYPE_IPV4) payload = ip(bytes, at);
  else if (ethertype === ETHERTYPE_IPV6) payload = { protocol: "IPv6", summary: `EtherType ${hex4(ethertype)} (IPv6)` };
  else payload = { protocol: "other", summary: `EtherType ${hex4(ethertype)}` };
  return { length, damaged: payload.protocol === "damaged", src, dst, vlan, ethertype, ...payload };
}
