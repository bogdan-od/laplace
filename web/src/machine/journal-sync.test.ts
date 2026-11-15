import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalEvent } from "@core/core/journal.mjs";
import type { AppendResult } from "@shared/api";
import { AUTOSAVE_MS, KEEPALIVE_MAX_BYTES } from "@shared/limits";
import { ApiFailure, NetworkFailure } from "@/lib/api";
import {
  JournalSync,
  commandsMeta,
  takeBatch,
  utf8Length,
  type BackoffLike,
  type ChunkRequest,
} from "./journal-sync";

function serial(index: number, data = "x"): JournalEvent {
  return { t: "serial", c: index * 10, w: 0, data };
}

function typed(text: string, start: number): JournalEvent[] {
  return [...text].map((char, i) => serial(start + i, char)).concat(serial(start + text.length, "\r"));
}

class FixedBackoff implements BackoffLike {
  delays: number[] = [];
  resets = 0;
  next(): number {
    this.delays.push(1000);
    return 1000;
  }
  reset(): void {
    this.resets++;
  }
}

/** A branch on a fake server: accepts a chunk only when `from` equals the stored count (409 otherwise). */
class FakeServer {
  count = 0;
  requests: ChunkRequest[] = [];
  failures: unknown[] = [];

  send = async (request: ChunkRequest): Promise<AppendResult> => {
    this.requests.push(request);
    const failure = this.failures.shift();
    if (failure) throw failure;
    const { from, events } = request.body;
    if (from !== this.count) {
      throw new ApiFailure(409, "Пропуск у журналі", "chunk_gap", { event_count: this.count });
    }
    this.count += events.length;
    return { event_count: this.count };
  };
}

describe("JournalSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(events: JournalEvent[], server: FakeServer, saved = 0, backoff = new FixedBackoff()) {
    const list = events;
    const sync = new JournalSync({ branchId: 7, saved, events: () => list, send: server.send, backoff });
    return { sync, list, backoff };
  }

  it("sends new events once per interval and reports saved", async () => {
    const server = new FakeServer();
    const { sync, list } = make([serial(0), serial(1)], server);
    sync.start();
    expect(server.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.body.from).toBe(0);
    expect(server.requests[0]?.body.events).toHaveLength(2);
    expect(server.requests[0]?.keepalive).toBe(false);
    expect(sync.getState()).toMatchObject({ status: "saved", saved: 2 });

    list.push(serial(2));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.body.from).toBe(2);
    expect(sync.saved).toBe(3);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    expect(server.requests).toHaveLength(2);
    sync.stop();
  });

  it("shows saving while a request is in flight", async () => {
    const server = new FakeServer();
    let release: (() => void) | undefined;
    const slow = (request: ChunkRequest) =>
      new Promise<AppendResult>((resolve) => {
        release = () => resolve({ event_count: request.body.from + request.body.events.length });
      });
    const sync = new JournalSync({ branchId: 1, saved: 0, events: () => [serial(0)], send: slow });
    const seen: string[] = [];
    sync.subscribe(() => seen.push(sync.getState().status));
    const flushing = sync.flushNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.getState().status).toBe("saving");
    release?.();
    await flushing;
    expect(seen[0]).toBe("saving");
    expect(seen.at(-1)).toBe("saved");
    expect(server.requests).toHaveLength(0);
    sync.stop();
  });

  it("on 409 chunk_gap continues from the server's event_count", async () => {
    const server = new FakeServer();
    server.count = 3; // the server got events 0..2 earlier, our answer was lost
    const events = [0, 1, 2, 3, 4].map((i) => serial(i));
    const { sync } = make(events, server);
    await sync.flushNow();
    expect(server.requests.map((r) => r.body.from)).toEqual([0, 3]);
    expect(server.requests[1]?.body.events).toHaveLength(2);
    expect(server.count).toBe(5);
    expect(sync.getState()).toMatchObject({ status: "saved", saved: 5 });
    sync.stop();
  });

  it("a network failure goes offline and retries with the backoff delay, then recovers", async () => {
    const server = new FakeServer();
    server.failures.push(new NetworkFailure());
    const { sync, backoff } = make([serial(0), serial(1)], server);
    sync.start();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(sync.getState().status).toBe("offline");
    expect(backoff.delays).toEqual([1000]);
    expect(server.count).toBe(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(server.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.requests).toHaveLength(2);
    expect(sync.getState()).toMatchObject({ status: "saved", saved: 2 });
    expect(backoff.resets).toBeGreaterThan(0);
    sync.stop();
  });

  it("flushNow rejects with NetworkFailure offline and keeps retrying in the background", async () => {
    const server = new FakeServer();
    server.failures.push(new NetworkFailure());
    const { sync } = make([serial(0)], server);
    sync.start();
    await expect(sync.flushNow()).rejects.toBeInstanceOf(NetworkFailure);
    expect(sync.getState().status).toBe("offline");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync.getState()).toMatchObject({ status: "saved", saved: 1 });
    sync.stop();
  });

  it("a refusal (4xx) is not retried", async () => {
    const server = new FakeServer();
    server.failures.push(new ApiFailure(400, "Журнал недійсний", "journal_invalid", null));
    const { sync } = make([serial(0)], server);
    sync.start();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(sync.getState()).toMatchObject({ status: "error", error: "Журнал недійсний" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 5);
    expect(server.requests).toHaveLength(1);
    sync.stop();
  });

  it("splits a long journal into chunks by size", async () => {
    const server = new FakeServer();
    const big = "a".repeat(1000);
    const events = Array.from({ length: 10 }, (_, i) => serial(i, big));
    const sync = new JournalSync({ branchId: 1, saved: 0, events: () => events, send: server.send, chunkBytes: 3500 });
    await sync.flushNow();
    expect(server.requests.map((r) => r.body.events.length)).toEqual([3, 3, 3, 1]);
    expect(server.count).toBe(10);
    sync.stop();
  });

  it("serializes overlapping flushes: the same events are never sent twice", async () => {
    const server = new FakeServer();
    const { sync } = make([serial(0), serial(1)], server);
    await Promise.all([sync.flushNow(), sync.flushNow(), sync.flushNow()]);
    expect(server.requests).toHaveLength(1);
    sync.stop();
  });

  it("flushNow can take the events from a journal that is ahead of the copy", async () => {
    const server = new FakeServer();
    const { sync } = make([serial(0)], server);
    await sync.flushNow([serial(0), serial(1), { t: "check", c: 20, w: 0, h: "a", m: "b" }]);
    expect(server.count).toBe(3);
    // the machine copy still has one event: nothing new, no failure
    await sync.flushNow();
    expect(sync.getState()).toMatchObject({ status: "saved", saved: 3 });
    sync.stop();
  });

  describe("pagehide", () => {
    it("sends a small chunk with keepalive", () => {
      const server = new FakeServer();
      const { sync } = make([serial(0), serial(1)], server);
      sync.onPageHide();
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.keepalive).toBe(true);
      sync.stop();
    });

    it("does not use keepalive for a chunk larger than KEEPALIVE_MAX_BYTES", () => {
      const server = new FakeServer();
      const events = Array.from({ length: 4 }, (_, i) => serial(i, "b".repeat(KEEPALIVE_MAX_BYTES / 2)));
      const { sync } = make(events, server);
      sync.onPageHide();
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.keepalive).toBe(false);
      expect(takeBatch(events, 0, 4 * 2 ** 20).bytes).toBeGreaterThan(KEEPALIVE_MAX_BYTES);
      sync.stop();
    });

    it("starts the request synchronously and does nothing without new events", () => {
      const server = new FakeServer();
      const { sync } = make([], server);
      sync.onPageHide();
      expect(server.requests).toHaveLength(0);
      sync.stop();
    });
  });

  it("onHidden sends at once", async () => {
    const server = new FakeServer();
    const { sync } = make([serial(0)], server);
    sync.onHidden();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.count).toBe(1);
    sync.stop();
  });

  it("sends meta with the number of the student's commands and the last one", async () => {
    const server = new FakeServer();
    const events = [...typed("ls", 0), ...typed("echo hi", 3)];
    const { sync } = make(events, server);
    await sync.flushNow();
    expect(server.requests[0]?.body.meta).toEqual({ commands: 2, last_command: "echo hi" });
    sync.stop();
  });

  it("flushAndStop saves and then no timer runs", async () => {
    const server = new FakeServer();
    const { sync } = make([serial(0)], server);
    sync.start();
    await sync.flushAndStop();
    expect(server.count).toBe(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 3);
    expect(server.requests).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("utf8Length counts bytes", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("привіт")).toBe(12);
    expect(utf8Length("€")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
    expect(utf8Length("😀")).toBe(new TextEncoder().encode("😀").length);
  });

  it("commandsMeta ignores the teacher's input and an empty journal", () => {
    expect(commandsMeta([])).toEqual({ commands: 0, last_command: "" });
    const teacher: JournalEvent[] = [...typed("id", 0)].map((e) => (e.t === "serial" ? { ...e, by: "teacher" } : e));
    expect(commandsMeta(teacher).commands).toBe(0);
  });
});
