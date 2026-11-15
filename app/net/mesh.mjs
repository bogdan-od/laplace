import { number_of } from "./room.mjs";
import { from_base64, to_base64 } from "./base64.mjs";
import { frame_ok, mac_key } from "./frame.mjs";

const STUN_PARAM = "stun";
const RTC_PARAM = "rtc";
const RTC_OFF = "off";
const FALLBACK_MS = 5000;
const DISCONNECT_GRACE_MS = 3000;
const MAX_MAC_TABLE = 1024;

export class Mesh extends EventTarget {
    #room;
    #machine;
    #links = new Map();
    #owner_of_mac = new Map();
    #ice_servers;
    #rtc_enabled;
    #closed = false;

    constructor(room, machine) {
        super();
        this.#room = room;
        this.#machine = machine;
        this.#ice_servers = ice_from_url();
        this.#rtc_enabled = new URLSearchParams(location.search).get(RTC_PARAM) !== RTC_OFF;
        // Room has no `off`: after close() its messages are ignored here.
        const open = handler => msg => this.#closed ? undefined : handler(msg);
        room.on("peer-joined", open(msg => this.#on_peer_joined(msg)));
        room.on("peer-left", open(msg => this.#drop(msg.id)));
        room.on("signal", open(msg => this.#on_signal(msg).catch(error => { if(!this.#closed) throw error; })));
        room.on("frame", open(msg => this.#from_server(msg)));
        room.on("joined", open(() => this.#rebuild()));
        this.#connect_all();
    }

    get peer_count() {
        return [...this.#links.values()].filter(link => link.via_server || link.channel?.readyState === "open").length;
    }

    get server_count() {
        return [...this.#links.values()].filter(link => link.via_server).length;
    }

    knows_destination(frame) {
        return this.#links.has(this.#owner_of_mac.get(mac_key(frame, 0)));
    }

    send_known(frame) {
        this.#send(this.#owner_of_mac.get(mac_key(frame, 0)), frame);
    }

    send_all(frame) {
        for(const peer_id of this.#links.keys()) this.#send(peer_id, frame);
    }

    /** Closes every RTCPeerConnection and stops the timers; the mesh then neither sends nor receives. Idempotent. */
    close() {
        if(this.#closed) return;
        this.#closed = true;
        for(const peer_id of [...this.#links.keys()]) this.#drop(peer_id);
    }

    // Rejoining the room (lost server link, server restart): the old links are not trustworthy, so they are rebuilt.
    #rebuild() {
        for(const peer_id of [...this.#links.keys()]) this.#drop(peer_id);
        this.#connect_all();
    }

    #connect_all() {
        for(const [id, peer] of this.#room.peers) this.#on_peer_joined({ id, role: peer.role });
    }

    // peer-joined for a known neighbour means it has joined again: its old link is dead.
    #on_peer_joined(msg) {
        if(!this.#is_neighbour(msg)) return;
        this.#drop(msg.id);
        if(!this.#rtc_enabled) return this.#connect_via_server(msg.id);
        if(number_of(this.#room.id) < number_of(msg.id)) this.#connect(msg.id, true);
    }

    #is_neighbour(msg) {
        return msg.role === "student" && msg.id !== this.#room.id;
    }

    #connect_via_server(peer_id) {
        if(this.#links.has(peer_id)) return;
        this.#links.set(peer_id, { pc: null, via_server: true });
        this.dispatchEvent(new Event("change"));
    }

    // Frames of this neighbour go through the server when the DataChannel did not open in time or broke.
    #to_server(peer_id) {
        const link = this.#links.get(peer_id);
        if(!link || link.via_server) return;
        clearTimeout(link.timer);
        clearTimeout(link.lost_timer);
        link.pc.close();
        Object.assign(link, { pc: null, channel: null, via_server: true });
        this.dispatchEvent(new Event("change"));
    }

    #connect(peer_id, offering) {
        if(this.#links.has(peer_id)) return;
        const pc = new RTCPeerConnection({ iceServers: this.#ice_servers });
        const link = { pc, channel: null, remote_ready: false, pending: [], via_server: false };
        link.timer = setTimeout(() => this.#to_server(peer_id), FALLBACK_MS);
        this.#links.set(peer_id, link);
        pc.onicecandidate = event => event.candidate && this.#signal(peer_id, { kind: "candidate", candidate: event.candidate.toJSON() });
        pc.onconnectionstatechange = () => this.#changed(peer_id, link, pc.connectionState);
        pc.ondatachannel = event => this.#attach(peer_id, event.channel);
        if(offering) this.#offer(peer_id, link);
    }

    async #offer(peer_id, link) {
        this.#attach(peer_id, link.pc.createDataChannel("net"));
        await link.pc.setLocalDescription(await link.pc.createOffer());
        this.#signal(peer_id, { kind: "offer", sdp: link.pc.localDescription.sdp });
    }

    #attach(peer_id, channel) {
        const link = this.#links.get(peer_id);
        if(!link) return channel.close();
        link.channel = channel;
        channel.binaryType = "arraybuffer";
        channel.onopen = () => { clearTimeout(link.timer); this.#changed(peer_id, link, "open"); };
        channel.onclose = () => this.#changed(peer_id, link, "closed");
        channel.onmessage = event => event.data instanceof ArrayBuffer && this.#from_remote(peer_id, new Uint8Array(event.data));
    }

    async #on_signal(msg) {
        if(!this.#rtc_enabled) return;
        const data = msg.data;
        if(data.kind === "offer") return this.#on_offer(msg.from, data.sdp);
        if(this.#links.get(msg.from)?.via_server) return;
        if(data.kind === "answer") await this.#on_answer(msg.from, data.sdp);
        if(data.kind === "candidate") await this.#on_candidate(msg.from, data.candidate);
    }

    // An offer from a neighbour linked through the server brings up a DataChannel in its place: the server link is the
    // fallback.
    async #on_offer(peer_id, sdp) {
        if(this.#links.get(peer_id)?.via_server) this.#links.delete(peer_id);
        if(!this.#links.has(peer_id)) this.#connect(peer_id, false);
        const link = this.#links.get(peer_id);
        await link.pc.setRemoteDescription({ type: "offer", sdp });
        await this.#ready(link);
        await link.pc.setLocalDescription(await link.pc.createAnswer());
        this.#signal(peer_id, { kind: "answer", sdp: link.pc.localDescription.sdp });
    }

    async #on_answer(peer_id, sdp) {
        const link = this.#links.get(peer_id);
        if(!link) return;
        await link.pc.setRemoteDescription({ type: "answer", sdp });
        await this.#ready(link);
    }

    async #on_candidate(peer_id, candidate) {
        const link = this.#links.get(peer_id);
        if(!link) return;
        if(!link.remote_ready) return link.pending.push(candidate);
        await link.pc.addIceCandidate(candidate);
    }

    async #ready(link) {
        link.remote_ready = true;
        for(const candidate of link.pending.splice(0)) await link.pc.addIceCandidate(candidate);
    }

    #signal(peer_id, data) {
        this.#room.send({ type: "signal", to: peer_id, data });
    }

    #from_remote(peer_id, frame, learn = true) {
        if(!frame_ok(frame)) return;
        if(learn) this.#learn(mac_key(frame, 6), peer_id);
        this.#machine.net_in(frame);
    }

    #learn(key, peer_id) {
        if(!this.#owner_of_mac.has(key) && this.#owner_of_mac.size >= MAX_MAC_TABLE) this.#owner_of_mac.clear();
        this.#owner_of_mac.set(key, peer_id);
    }

    // A frame from a sender without a link (it left the room or its offer is still on the way) is delivered, but
    // creates no link
    // and does not teach the MAC table: otherwise a "ghost" link would appear, and the offer for this neighbour would
    // have to be ignored.
    #from_server(msg) {
        this.#from_remote(msg.from, from_base64(msg.data), this.#links.has(msg.from));
    }

    // While the DataChannel is not open (still connecting or already failed), frames go through the server.
    #send(peer_id, frame) {
        const link = this.#links.get(peer_id);
        if(link.channel?.readyState === "open") return link.channel.send(frame);
        this.#room.send({ type: "frame", to: peer_id, data: to_base64(frame) });
    }

    #changed(peer_id, link, state) {
        if(this.#links.get(peer_id) !== link || link.via_server) return;
        if(state === "failed" || state === "closed") this.#to_server(peer_id);
        else if(state === "disconnected") link.lost_timer ??= setTimeout(() => this.#to_server(peer_id), DISCONNECT_GRACE_MS);
        else if(state === "connected" || state === "open") { clearTimeout(link.lost_timer); link.lost_timer = null; }
        this.dispatchEvent(new Event("change"));
    }

    #drop(peer_id) {
        const link = this.#links.get(peer_id);
        if(!link) return;
        clearTimeout(link.timer);
        clearTimeout(link.lost_timer);
        link.pc?.close();
        this.#links.delete(peer_id);
        for(const [mac, owner] of this.#owner_of_mac) {
            if(owner === peer_id) this.#owner_of_mac.delete(mac);
        }
        this.dispatchEvent(new Event("change"));
    }
}

function ice_from_url() {
    const stun = new URLSearchParams(location.search).get(STUN_PARAM);
    return stun ? [{ urls: stun }] : [];
}
