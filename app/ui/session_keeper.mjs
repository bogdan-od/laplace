// Saves the live machine's journal in IndexedDB: periodically, when the tab opens or closes, and after a rollback.
import { SessionStore } from "./session_store.mjs";

const SAVE_EVERY_MS = 15000;
const SESSION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const ROOM_KEY_PREFIX = "v86-replay:room-key:";

export const session_key = ({ profile, task, room, name }) => JSON.stringify([profile, task ?? "", room ?? "", name]);

export const room_key_name = room => ROOM_KEY_PREFIX + room;

// IndexedDB may be unavailable (private window, blocked): then the session is simply not saved.
export async function open_store() {
    try {
        const store = await SessionStore.open();
        await store.prune(SESSION_MAX_AGE_MS);
        return store;
    } catch(error) {
        console.warn("IndexedDB is unavailable, the session will not be saved:", error);
        return null;
    }
}

// An unfinished saved session: {meta, events}; a broken or empty one is removed.
export async function find_unfinished(store, key) {
    const saved = await store.load(key);
    if(saved && saved.events.length) return saved;
    await store.remove(key);
    return null;
}

export class SessionKeeper {
    #store;
    #machine;
    #key;
    #owner = crypto.randomUUID();
    #room;
    #saved = 0;
    #chain = Promise.resolve();
    #active = true;

    constructor(store, machine, { key, room }) {
        this.#store = store;
        this.#machine = machine;
        this.#key = key;
        this.#room = room;
    }

    // restored - a session from the store (its events are already there), otherwise a new one starts.
    async begin(restored) {
        if(restored) {
            await this.#store.adopt(this.#key, this.#owner);
            this.#saved = restored.events.length;
        } else {
            const header = this.#machine.header_now();
            await this.#store.create(this.#key, { owner: this.#owner, header, profile: header.profile });
        }
        this.#machine.on("truncated", index => this.#truncate(index));
        setInterval(() => this.save(), SAVE_EVERY_MS);
        addEventListener("pagehide", () => this.save());
        document.addEventListener("visibilitychange", () => document.hidden && this.save());
    }

    save() {
        if(!this.#active) return this.#chain;
        this.#chain = this.#chain.then(() => this.#flush()).catch(error => console.warn("Saving the session:", error));
        return this.#chain;
    }

    // The session is submitted: remove it from the store and stop writing.
    finish() {
        this.#active = false;
        this.#chain = this.#chain.then(() => this.#store.remove(this.#key)).catch(error => console.warn("Deleting the session:", error));
        return this.#chain;
    }

    async #flush() {
        const from = this.#saved;
        const events = this.#machine.mirror.slice(from);
        const room_key = this.#room ? sessionStorage.getItem(room_key_name(this.#room)) : null;
        if(!await this.#store.append(this.#key, this.#owner, from, events, room_key)) this.#active = false;
        else this.#saved = from + events.length;
    }

    #truncate(index) {
        this.#chain = this.#chain
            .then(async () => {
                await this.#store.truncate(this.#key, this.#owner, index);
                this.#saved = Math.min(this.#saved, index);
            })
            .catch(error => console.warn("Rolling back the saved session:", error));
    }
}
