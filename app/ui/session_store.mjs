// Student session store in IndexedDB: the live machine's journal survives a tab crash.
// The journal is written in parts (each holds the new events since the last write), not as a whole.
const DB_NAME = "v86-replay";
const DB_VERSION = 1;
const SESSIONS = "sessions";
const EVENTS = "events";
const FIRST_START = 0;

const done = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB: транзакцію скасовано"));
});

const result = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

const events_of = key => IDBKeyRange.bound([key, FIRST_START], [key, Infinity]);

export class SessionStore {
    #db;

    constructor(db) {
        this.#db = db;
    }

    static async open() {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(SESSIONS, { keyPath: "key" });
            request.result.createObjectStore(EVENTS, { keyPath: ["key", "start"] });
        };
        return new SessionStore(await result(request));
    }

    // {meta, events}, or null if there is no session or the stored journal has a gap.
    async load(key) {
        const tx = this.#db.transaction([SESSIONS, EVENTS], "readonly");
        const meta = await result(tx.objectStore(SESSIONS).get(key));
        if(!meta) return null;
        const chunks = await result(tx.objectStore(EVENTS).getAll(events_of(key)));
        const events = [];
        for(const chunk of chunks) {
            if(chunk.start !== events.length) return null;
            for(const event of chunk.events) events.push(event);
        }
        return { meta, events };
    }

    // A new session replaces the old one with the same key. owner is a tab mark: another tab with the same
    // parameters takes the session over, and the first one then writes nothing.
    async create(key, meta) {
        const tx = this.#db.transaction([SESSIONS, EVENTS], "readwrite");
        tx.objectStore(EVENTS).delete(events_of(key));
        tx.objectStore(SESSIONS).put({ ...meta, key, count: 0, updated: Date.now() });
        await done(tx);
    }

    async adopt(key, owner) {
        const tx = this.#db.transaction(SESSIONS, "readwrite");
        const meta = await result(tx.objectStore(SESSIONS).get(key));
        if(meta) tx.objectStore(SESSIONS).put({ ...meta, owner, updated: Date.now() });
        await done(tx);
    }

    // false if the session was taken by another tab or deleted.
    async append(key, owner, start, events, room_key) {
        const tx = this.#db.transaction([SESSIONS, EVENTS], "readwrite");
        const meta = await result(tx.objectStore(SESSIONS).get(key));
        if(!meta || meta.owner !== owner) return false;
        if(events.length) tx.objectStore(EVENTS).put({ key, start, events });
        tx.objectStore(SESSIONS).put({ ...meta, count: start + events.length, room_key, updated: Date.now() });
        await done(tx);
        return true;
    }

    // Machine rollback: events from number `index` on are no longer part of the journal.
    async truncate(key, owner, index) {
        const tx = this.#db.transaction([SESSIONS, EVENTS], "readwrite");
        const meta = await result(tx.objectStore(SESSIONS).get(key));
        if(!meta || meta.owner !== owner) return;
        const store = tx.objectStore(EVENTS);
        for(const chunk of await result(store.getAll(events_of(key)))) {
            if(chunk.start >= index) store.delete([key, chunk.start]);
            else if(chunk.start + chunk.events.length > index) store.put({ ...chunk, events: chunk.events.slice(0, index - chunk.start) });
        }
        tx.objectStore(SESSIONS).put({ ...meta, count: Math.min(meta.count, index), updated: Date.now() });
        await done(tx);
    }

    async remove(key) {
        const tx = this.#db.transaction([SESSIONS, EVENTS], "readwrite");
        tx.objectStore(EVENTS).delete(events_of(key));
        tx.objectStore(SESSIONS).delete(key);
        await done(tx);
    }

    async prune(max_age_ms) {
        const old = Date.now() - max_age_ms;
        const sessions = await result(this.#db.transaction(SESSIONS, "readonly").objectStore(SESSIONS).getAll());
        for(const meta of sessions) if(meta.updated < old) await this.remove(meta.key);
    }
}
