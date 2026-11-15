// Report queue: a server refusal (4xx) is not "no connection" and is not retried; a network error, 5xx, 408 and 429 are
// retried.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const note = { textContent: "" };
globalThis.document = { getElementById: () => note };
const { ReportQueue, upload_journal } = await import("../ui/report_queue.mjs");

const RETRY_MS = 3000;
const journal = { header: {}, events: [] };

async function with_fetch(response, fn) {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
        if(response instanceof Error) throw response;
        return { ok: response.status < 400, status: response.status, json: async () => ({ id: "abc" }) };
    };
    try { return await fn(); } finally { globalThis.fetch = original; }
}

test("upload_journal: a 413 refusal is an error with a code, not null", async () => {
    await with_fetch({ status: 413 }, () => assert.rejects(upload_journal(journal), /413.*завеликий/));
    await with_fetch({ status: 400 }, () => assert.rejects(upload_journal(journal), /400/));
});

test("upload_journal: a network error, 5xx, 408 and 429 give null, retry later; success gives an id", async () => {
    await with_fetch(new TypeError("fetch failed"), async () => assert.equal(await upload_journal(journal), null));
    for(const status of [500, 503, 408, 429]) await with_fetch({ status }, async () => assert.equal(await upload_journal(journal), null));
    await with_fetch({ status: 200 }, async () => assert.equal(await upload_journal(journal), "abc"));
});

test("ReportQueue: a server refusal is shown once and not retried", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const queue = new ReportQueue({ upload: async () => { calls++; throw new Error("Сервер не прийняв журнал (413): журнал завеликий"); }, on_link: () => {}, on_submitted: () => {} });
    await queue.add("submit", journal);
    t.mock.timers.tick(RETRY_MS * 3);
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.match(note.textContent, /413/);
});

test("ReportQueue: a refusal of one report does not block the next one", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const uploads = [];
    const upload = async j => { uploads.push(j); if(uploads.length === 1) throw new Error("відмова"); return "id2"; };
    const links = [];
    const queue = new ReportQueue({ upload, on_link: id => links.push(id), on_submitted: () => {} });
    await queue.add("help", journal);
    await queue.add("submit", journal);
    assert.equal(uploads.length, 2);
    assert.deepEqual(links, ["id2"]);
});

test("ReportQueue: no connection - the report is retried after 3 s", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const queue = new ReportQueue({ upload: async () => (++calls < 2 ? null : "id"), on_link: () => {}, on_submitted: () => {} });
    await queue.add("submit", journal);
    assert.equal(calls, 1);
    t.mock.timers.tick(RETRY_MS);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
});
