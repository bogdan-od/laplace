import { $ } from "./common.mjs";

const RETRY_MS = 3000;

class ServerUnavailable extends Error {}

// Responses after which a retry may help: the server is overloaded or asks to wait.
const RETRYABLE_STATUSES = new Set([408, 429]);

// Uploads a journal to the server: the journal id, or null if the server is unreachable (the report is then retried).
// A server refusal (for example, 413 for a journal over the limit) is an error with text: a retry would not change
// anything.
export async function upload_journal(journal) {
    try {
        const response = await fetch("/journals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(journal),
        }).catch(network_failure);
        if(!response.ok) throw refusal(response.status);
        return (await response.json()).id;
    } catch (error) {
        if(!(error instanceof ServerUnavailable)) throw error;
        return null;
    }
}

function refusal(status) {
    if(status >= 500 || RETRYABLE_STATUSES.has(status)) return new ServerUnavailable();
    const reason = status === 413 ? ": журнал завеликий" : "";
    return new Error(`Сервер не прийняв журнал (${status})${reason}`);
}

function network_failure(error) {
    if(!(error instanceof TypeError)) throw error;
    throw new ServerUnavailable();
}

// Student reports ("У мене не працює", "Здати"). The journal is uploaded to the server and announced to the room;
// while there is no connection, the report stays in page memory and is retried. It counts as done once
// the room confirms it (or once uploaded, if there is no room).
export class ReportQueue {
    #entries = [];
    #room = null;
    #upload;
    #on_link;
    #on_submitted;
    #busy = false;
    #timer = null;

    // upload(journal) → journal id or null if the server is unavailable; on_submitted() - "Здати" is confirmed.
    constructor({ upload, on_link, on_submitted }) {
        this.#upload = upload;
        this.#on_link = on_link;
        this.#on_submitted = on_submitted;
    }

    attach(room) {
        this.#room = room;
        room.on("joined", () => this.flush());
        room.on("report-ack", msg => this.#acked(msg.ref));
    }

    // extra - additional fields of the "report" message (topology: machine, group).
    add(kind, journal, extra = {}) {
        this.#entries.push({ ref: crypto.randomUUID(), kind, journal, extra, id: null, done: false });
        return this.flush();
    }

    async flush() {
        if(this.#busy) return;
        this.#busy = true;
        try {
            for(const entry of this.#entries.filter(item => !item.done)) await this.#advance(entry);
        } finally {
            this.#busy = false;
        }
        this.#schedule_retry();
    }

    async #advance(entry) {
        if(entry.id === null) {
            try { entry.id = await this.#upload(entry.journal); }
            catch(error) { return this.#refused(entry, error); }
            if(entry.id === null) return say("Не надіслано, надішлю, щойно буде зв'язок із сервером (журнал можна зберегти файлом)");
            entry.journal = null;
            this.#on_link(entry.id);
        }
        if(!this.#room) return this.#finish(entry);
        const sent = this.#room.send({ type: "report", ref: entry.ref, journal_id: entry.id, kind: entry.kind, note: "", ...entry.extra });
        say(sent ? "Надіслано, чекаю підтвердження викладача…" : "Не надіслано викладачу, надішлю, щойно буде зв'язок із кімнатою");
    }

    // A server refusal, not a missing connection: the report leaves the queue and is not retried.
    #refused(entry, error) {
        this.#entries = this.#entries.filter(item => item !== entry);
        say(error.message);
    }

    #acked(ref) {
        const entry = this.#entries.find(item => item.ref === ref);
        if(entry && !entry.done) this.#finish(entry);
    }

    #finish(entry) {
        this.#entries = this.#entries.filter(item => item !== entry);
        entry.done = true;
        if(entry.kind === "submit") this.#on_submitted?.();
        if(this.#room) say(entry.kind === "submit" ? "Здано" : "Викладач отримав звіт");
        else say(entry.kind === "submit" ? "Журнал на сервері, посилання нижче" : "");
    }

    #schedule_retry() {
        clearTimeout(this.#timer);
        if(this.#entries.some(entry => !entry.done)) this.#timer = setTimeout(() => this.flush(), RETRY_MS);
    }
}

function say(text) {
    $("note").textContent = text;
}
