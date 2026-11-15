import { Backoff, CONNECT_TIMEOUT_MS } from "./backoff.mjs";

const STUDENT = "student";
const KEY_PREFIX = "v86-replay:room-key:";
const SLOT_PREFIX = "v86-replay:room-slot:";
const PING_MS = 5000;
const SILENCE_MS = 15000;

export const number_of = id => Number(id.slice(1));

// A room on the server. Reconnects without end; a student stays the same member by the key
// in sessionStorage. Server events go through on(type, fn); besides them there is "state": open | lost | replaced.
export class Room {
    id = null;
    peers = new Map();
    task = null;
    task_kind = "journal";
    reports = [];
    state = "connecting";
    #url;
    #join;
    #storage;
    #slot_key = null;
    #ws = null;
    #backoff = new Backoff();
    #handlers = new Map();
    #timers = { retry: null, ping: null, connect: null };
    #last_rx = 0;
    #first_join = null;

    constructor({ url = location.href, room, role = STUDENT, name = "", machines = null, storage = globalThis.sessionStorage }) {
        this.#url = url;
        this.#storage = storage;
        this.#join = { type: "join", room, role, name };
        if(machines) this.#join.machines = machines;
        if(role === STUDENT) {
            this.#join.key = stored(storage, KEY_PREFIX + room, () => crypto.randomUUID());
            this.#slot_key = SLOT_PREFIX + room;
            this.#join.slot = storage.getItem(this.#slot_key);
        }
        globalThis.addEventListener?.("online", () => this.#retry_now());
    }

    get is_open() {
        return this.state === "open";
    }

    // Resolves after the first join; later the room recovers from breaks by itself.
    connect() {
        if(!this.#first_join) {
            this.#first_join = new Promise(resolve => this.on("joined", () => resolve(this)));
            this.#open();
        }
        return this.#first_join;
    }

    on(type, fn) {
        if(!this.#handlers.has(type)) this.#handlers.set(type, []);
        this.#handlers.get(type).push(fn);
    }

    // false: there is no connection now and the message was not sent.
    send(message) {
        if(!this.is_open) return false;
        this.#ws.send(JSON.stringify(message));
        return true;
    }

    // A socket stuck in CONNECTING (TCP accepted, the handshake is silent) or one that never answered "join" gives
    // neither open nor an error: the silence watchdog is not running yet (it starts after "joined"), so this deadline
    // is separate.
    #open() {
        if(this.state === "replaced") return;
        if(this.#ws) this.#detach(this.#ws);
        const socket = new WebSocket(ws_url(this.#url));
        this.#ws = socket;
        this.#timers.connect = setTimeout(() => this.#lost(socket), CONNECT_TIMEOUT_MS);
        socket.onopen = () => { this.#last_rx = Date.now(); socket.send(JSON.stringify(this.#join)); };
        socket.onmessage = event => this.#receive(socket, JSON.parse(event.data));
        socket.onclose = () => this.#lost(socket);
        socket.onerror = () => this.#lost(socket);
    }

    #receive(socket, message) {
        if(socket !== this.#ws) return;
        this.#last_rx = Date.now();
        if(message.type === "replaced") return this.#stop();
        this.#update(message);
        for(const fn of [...(this.#handlers.get(message.type) ?? [])]) fn(message);
    }

    #update(message) {
        if(message.type === "joined") this.#fill(message);
        if(message.type === "peer-joined") this.peers.set(message.id, peer_of(message));
        if(message.type === "peer-left") this.peers.delete(message.id);
    }

    #fill(message) {
        this.id = message.id;
        this.task = message.task ?? null;
        this.task_kind = message.kind ?? "journal";
        this.reports = message.reports ?? [];
        this.peers = new Map(message.peers.map(peer => [peer.id, peer_of(peer)]));
        if(this.#slot_key) this.#storage.setItem(this.#slot_key, this.id);
        this.#join.slot = this.id;
        this.#backoff.reset();
        clearTimeout(this.#timers.connect);
        this.#timers.ping = setInterval(() => this.#tick(), PING_MS);
        this.#set_state("open");
    }

    #tick() {
        if(Date.now() - this.#last_rx > SILENCE_MS) return this.#lost(this.#ws);
        this.send({ type: "ping" });
    }

    #lost(socket) {
        if(socket !== this.#ws || this.state === "replaced") return;
        this.#detach(socket);
        this.#set_state("lost");
        this.#timers.retry = setTimeout(() => this.#open(), this.#backoff.next());
    }

    // Another tab with the same key took the seat: do not fight for it.
    #stop() {
        this.#detach(this.#ws);
        this.#set_state("replaced");
    }

    #detach(socket) {
        clearInterval(this.#timers.ping);
        clearTimeout(this.#timers.retry);
        clearTimeout(this.#timers.connect);
        Object.assign(socket, { onopen: null, onmessage: null, onclose: null, onerror: null });
        socket.close();
        this.#ws = null;
    }

    #retry_now() {
        if(this.state !== "lost") return;
        clearTimeout(this.#timers.retry);
        this.#open();
    }

    #set_state(state) {
        this.state = state;
        for(const fn of [...(this.#handlers.get("state") ?? [])]) fn({ type: "state", state });
    }
}

const peer_of = ({ role, name, machines }) => machines ? { role, name, machines } : { role, name };

function stored(storage, key, make) {
    const existing = storage.getItem(key);
    if(existing) return existing;
    const value = make();
    storage.setItem(key, value);
    return value;
}

function ws_url(page_url) {
    const url = new URL("/ws", page_url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
}
