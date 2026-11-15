// System channel protocol: request, a reply in several pieces, garbage on ttyS1, timeout, disconnect.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { AgentChannel, encode_request, parse_response } from "../machine/agent_channel.mjs";

const b64 = text => Buffer.from(text).toString("base64");
const bytes = text => [...Buffer.from(text)];

function channel() {
    const sent = [];
    return { sent, agent: new AgentChannel(text => sent.push(text)) };
}

const id_of = request => request.split(" ")[1];

test("encode_request: an @req line with base64; a multi-line and a Unicode command do not break the frame", () => {
    const line = encode_request("a1", "echo 'привіт'\nls");
    assert.match(line, /^@req a1 [A-Za-z0-9+/=]+\n$/);
    assert.equal(Buffer.from(line.split(" ")[2], "base64").toString(), "echo 'привіт'\nls");
});

test("parse_response: a reply, garbage, broken base64", () => {
    assert.deepEqual(parse_response(`@res x1 0 ${b64("ok\n")}`), { id: "x1", rc: 0, output: "ok\n" });
    assert.deepEqual(parse_response("@res x1 3 "), { id: "x1", rc: 3, output: "" });
    assert.equal(parse_response("hello"), null);
    assert.equal(parse_response("@res x1 abc"), null);
    assert.equal(parse_response("@res x1 0 ***"), null);
});

test("request: the reply arrives in pieces, garbage lines before it are ignored", async () => {
    const { sent, agent } = channel();
    const pending = agent.request("echo hi", 1000);
    const id = id_of(sent[0]);
    agent.feed(bytes("junk line\r\n@res other 0 \n"));
    agent.feed(bytes(`@res ${id} 7 ${b64("hi\n")}`.slice(0, 12)));
    agent.feed(bytes(`@res ${id} 7 ${b64("hi\n")}`.slice(12) + "\n"));
    assert.deepEqual(await pending, { rc: 7, output: "hi\n" });
});

test("request: concurrent requests are told apart by number", async () => {
    const { sent, agent } = channel();
    const first = agent.request("a", 1000);
    const second = agent.request("b", 1000);
    agent.feed(bytes(`@res ${id_of(sent[1])} 0 ${b64("B")}\n@res ${id_of(sent[0])} 0 ${b64("A")}\n`));
    assert.equal((await first).output, "A");
    assert.equal((await second).output, "B");
});

test("request: no reply - a timeout error with an explanation", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const { agent } = channel();
        const pending = agent.request("true", 10000);
        const failed = assert.rejects(pending, /Агент не відповів на системну команду за 10 с/);
        mock.timers.tick(10000);
        await failed;
    } finally {
        mock.timers.reset();
    }
});

test("reject_all: a drop rejects the waiting requests and resets the unread line", async () => {
    const { sent, agent } = channel();
    const pending = agent.request("true", 1000);
    agent.feed(bytes("@res half"));
    agent.reject_all(new Error("зупинено"));
    await assert.rejects(pending, /зупинено/);
    const next = agent.request("true", 1000);
    agent.feed(bytes(`@res ${id_of(sent[1])} 0 \n`));
    assert.deepEqual(await next, { rc: 0, output: "" });
});

test("request: seconds while the emulator stands still do not count toward the timeout", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
        const sent = [];
        let stalled = true;
        const agent = new AgentChannel(text => sent.push(text), { stalled: () => stalled });
        const pending = agent.request("true", 1000);
        let outcome = "чекає";
        pending.then(() => { outcome = "відповів"; }, () => { outcome = "timeout"; });
        mock.timers.tick(1000);
        await Promise.resolve();
        assert.equal(outcome, "чекає", "idle time in the first second must extend the deadline");
        stalled = false;
        mock.timers.tick(999);
        await Promise.resolve();
        assert.equal(outcome, "чекає");
        mock.timers.tick(1);
        await assert.rejects(pending, /Агент не відповів/);
    } finally {
        mock.timers.reset();
    }
});

test("request: the reply arrives, polling timers do not keep the process alive", async () => {
    const { sent, agent } = channel();
    const pending = agent.request("true", 10000);
    agent.feed(bytes(`@res ${id_of(sent[0])} 0 \n`));
    assert.deepEqual(await pending, { rc: 0, output: "" });
});
