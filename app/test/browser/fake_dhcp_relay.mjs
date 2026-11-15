// Fake wsproxy relay with a DHCP server: it answers the guest's DISCOVER and REQUEST with OFFER and ACK
// addressed to the guest's MAC (unicast) rather than broadcast. This is how a real DHCP server answers when
// the client did not ask for broadcast; broadcast replies would be accepted by the network card even without the right
// MAC.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE_BINARY = 0x82;
const OPCODE_CLOSE = 8;
const LENGTH_16_MARK = 126;
const LENGTH_64_MARK = 127;
const MASK_BIT = 0x80;

const MAC_BYTES = 6;
const MAC_SRC_OFFSET = 6;
const ETH_HEADER_BYTES = 14;
const ETHERTYPE_IPV4 = 0x0800;
const IP_HEADER_BYTES = 20;
const IP_PROTO_UDP = 17;
const IP_TTL = 64;
const UDP_HEADER_BYTES = 8;
const DHCP_SERVER_PORT = 67;
const DHCP_CLIENT_PORT = 68;
const BOOTP_HEADER_BYTES = 236;
const BOOTP_MIN_BYTES = 300;
const BOOTP_REPLY = 2;
const HTYPE_ETHERNET = 1;
const DHCP_COOKIE = [99, 130, 83, 99];
const OPTION_MESSAGE_TYPE = 53;
const OPTIONS_OFFSET = BOOTP_HEADER_BYTES + DHCP_COOKIE.length;
const DHCP_DISCOVER = 1;
const DHCP_REQUEST = 3;
const DHCP_OFFER = 2;
const DHCP_ACK = 5;
const LEASE_SECONDS = 86400;

const SERVER_MAC = [0x02, 0xaa, 0xbb, 0xcc, 0xdd, 0x01];
const SERVER_IP = [10, 5, 0, 1];
const CLIENT_IP = [10, 5, 7, 221];
const NETMASK = [255, 255, 255, 0];

function read_ws_frames(client) {
    const frames = [];
    for(;;) {
        const { buffer } = client;
        if(buffer.length < 2) return frames;
        const mark = buffer[1] & 0x7f;
        const head = 2 + (mark === LENGTH_16_MARK ? 2 : mark === LENGTH_64_MARK ? 8 : 0);
        const length = mark === LENGTH_16_MARK ? buffer.readUInt16BE(2) : mark === LENGTH_64_MARK ? Number(buffer.readBigUInt64BE(2)) : mark;
        const masked = (buffer[1] & MASK_BIT) !== 0;
        const total = head + (masked ? 4 : 0) + length;
        if(buffer.length < total) return frames;
        const payload = Buffer.from(buffer.subarray(head + (masked ? 4 : 0), total));
        if(masked) payload.forEach((byte, i) => { payload[i] = byte ^ buffer[head + (i % 4)]; });
        frames.push({ opcode: buffer[0] & 0x0f, payload });
        client.buffer = buffer.subarray(total);
    }
}

function ws_binary(payload) {
    const head = payload.length < LENGTH_16_MARK
        ? Buffer.from([OPCODE_BINARY, payload.length])
        : Buffer.from([OPCODE_BINARY, LENGTH_16_MARK, payload.length >> 8, payload.length & 0xff]);
    return Buffer.concat([head, payload]);
}

function ip_checksum(header) {
    let sum = 0;
    for(let i = 0; i < header.length; i += 2) sum += header.readUInt16BE(i);
    while(sum > 0xffff) sum = (sum & 0xffff) + (sum >> 16);
    return ~sum & 0xffff;
}

// Returns {type, xid, client_mac, flags} of a DHCP request from the client, or null if the frame is not DHCP.
function parse_dhcp_request(frame) {
    const ip_at = ETH_HEADER_BYTES;
    if(frame.length < OPTIONS_OFFSET + ETH_HEADER_BYTES + IP_HEADER_BYTES + UDP_HEADER_BYTES) return null;
    if(frame.readUInt16BE(2 * MAC_BYTES) !== ETHERTYPE_IPV4 || frame[ip_at + 9] !== IP_PROTO_UDP) return null;
    const udp_at = ip_at + (frame[ip_at] & 0x0f) * 4;
    if(frame.readUInt16BE(udp_at + 2) !== DHCP_SERVER_PORT) return null;
    const bootp = frame.subarray(udp_at + UDP_HEADER_BYTES);
    if(bootp.length < OPTIONS_OFFSET || !DHCP_COOKIE.every((byte, i) => bootp[BOOTP_HEADER_BYTES + i] === byte)) return null;
    return { type: message_type(bootp), xid: bootp.subarray(4, 8), flags: bootp.subarray(10, 12), client_mac: bootp.subarray(28, 28 + MAC_BYTES) };
}

function message_type(bootp) {
    for(let at = OPTIONS_OFFSET; at + 1 < bootp.length && bootp[at] !== 255;) {
        if(bootp[at] === 0) { at += 1; continue; }
        if(bootp[at] === OPTION_MESSAGE_TYPE) return bootp[at + 2];
        at += 2 + bootp[at + 1];
    }
    return null;
}

function dhcp_options(type) {
    return Buffer.from([
        OPTION_MESSAGE_TYPE, 1, type, 54, 4, ...SERVER_IP,
        51, 4, LEASE_SECONDS >>> 24, (LEASE_SECONDS >> 16) & 0xff, (LEASE_SECONDS >> 8) & 0xff, LEASE_SECONDS & 0xff,
        1, 4, ...NETMASK, 3, 4, ...SERVER_IP, 6, 4, ...SERVER_IP, 255,
    ]);
}

function dhcp_reply_frame(request, type) {
    const bootp = Buffer.alloc(BOOTP_MIN_BYTES);
    bootp[0] = BOOTP_REPLY;
    bootp[1] = HTYPE_ETHERNET;
    bootp[2] = MAC_BYTES;
    request.xid.copy(bootp, 4);
    request.flags.copy(bootp, 10);
    Buffer.from(CLIENT_IP).copy(bootp, 16);
    Buffer.from(SERVER_IP).copy(bootp, 20);
    request.client_mac.copy(bootp, 28);
    Buffer.from(DHCP_COOKIE).copy(bootp, BOOTP_HEADER_BYTES);
    dhcp_options(type).copy(bootp, OPTIONS_OFFSET);

    const udp = Buffer.alloc(UDP_HEADER_BYTES);
    udp.writeUInt16BE(DHCP_SERVER_PORT, 0);
    udp.writeUInt16BE(DHCP_CLIENT_PORT, 2);
    udp.writeUInt16BE(UDP_HEADER_BYTES + bootp.length, 4);

    const ip = Buffer.alloc(IP_HEADER_BYTES);
    ip[0] = 0x45;
    ip.writeUInt16BE(IP_HEADER_BYTES + udp.length + bootp.length, 2);
    ip[8] = IP_TTL;
    ip[9] = IP_PROTO_UDP;
    Buffer.from(SERVER_IP).copy(ip, 12);
    Buffer.from(CLIENT_IP).copy(ip, 16);
    ip.writeUInt16BE(ip_checksum(ip), 10);

    const eth = Buffer.alloc(ETH_HEADER_BYTES);
    request.client_mac.copy(eth, 0);
    Buffer.from(SERVER_MAC).copy(eth, MAC_SRC_OFFSET);
    eth.writeUInt16BE(ETHERTYPE_IPV4, 2 * MAC_BYTES);
    return Buffer.concat([eth, ip, udp, bootp]);
}

// stats: how many OFFERs and ACKs were sent and how many of them were unicast (addressed to the guest's MAC without the
// group bit).
export async function start_dhcp_relay() {
    const stats = { offers: 0, acks: 0, unicast: 0, received: 0 };
    const frames = [];
    const server = createServer();
    server.on("upgrade", (req, socket) => {
        const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + WS_GUID).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        const client = { buffer: Buffer.alloc(0) };
        socket.on("data", chunk => {
            client.buffer = Buffer.concat([client.buffer, chunk]);
            for(const { opcode, payload } of read_ws_frames(client)) {
                if(opcode === OPCODE_CLOSE) return socket.end();
                stats.received += 1;
                frames.push(payload);
                answer(socket, payload);
            }
        });
        socket.on("error", () => {});
    });

    function answer(socket, frame) {
        const request = parse_dhcp_request(frame);
        if(!request || ![DHCP_DISCOVER, DHCP_REQUEST].includes(request.type)) return;
        const reply_type = request.type === DHCP_DISCOVER ? DHCP_OFFER : DHCP_ACK;
        if(reply_type === DHCP_OFFER) stats.offers += 1;
        else stats.acks += 1;
        if((request.client_mac[0] & 1) === 0) stats.unicast += 1;
        socket.write(ws_binary(dhcp_reply_frame(request, reply_type)));
    }

    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { stats, port: server.address().port, frames, close: () => server.closeAllConnections() || server.close() };
}
