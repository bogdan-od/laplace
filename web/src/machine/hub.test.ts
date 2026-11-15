import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineHub, RELEASE_DELAY_MS, type HubSession } from "./hub";

class FakeSession implements HubSession {
  disposed = 0;
  dispose(): void {
    this.disposed++;
  }
}

describe("MachineHub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a double mount (acquire, release, acquire within 1 s) creates one session", () => {
    const hub = new MachineHub<FakeSession>();
    const create = vi.fn(() => new FakeSession());

    const first = hub.acquire("attempt:1", create);
    hub.release("attempt:1");
    vi.advanceTimersByTime(RELEASE_DELAY_MS - 1);
    const second = hub.acquire("attempt:1", create);

    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RELEASE_DELAY_MS * 5);
    expect(first.disposed).toBe(0);
    expect(hub.size).toBe(1);
  });

  it("a release without a new acquire disposes the session after 1 s", () => {
    const hub = new MachineHub<FakeSession>();
    const session = hub.acquire("attempt:1", () => new FakeSession());
    hub.release("attempt:1");
    vi.advanceTimersByTime(RELEASE_DELAY_MS - 1);
    expect(session.disposed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(session.disposed).toBe(1);
    expect(hub.size).toBe(0);
    expect(hub.peek("attempt:1")).toBeUndefined();
  });

  it("keeps the session while any subscriber remains", () => {
    const hub = new MachineHub<FakeSession>();
    const session = hub.acquire("a", () => new FakeSession());
    hub.acquire("a", () => new FakeSession());
    hub.release("a");
    vi.advanceTimersByTime(RELEASE_DELAY_MS * 3);
    expect(session.disposed).toBe(0);
    hub.release("a");
    vi.advanceTimersByTime(RELEASE_DELAY_MS);
    expect(session.disposed).toBe(1);
  });

  it("creates a new session after the old one was disposed", () => {
    const hub = new MachineHub<FakeSession>();
    const first = hub.acquire("a", () => new FakeSession());
    hub.release("a");
    vi.advanceTimersByTime(RELEASE_DELAY_MS);
    const second = hub.acquire("a", () => new FakeSession());
    expect(second).not.toBe(first);
  });

  it("different keys are different sessions; an extra release is harmless", () => {
    const hub = new MachineHub<FakeSession>();
    const a = hub.acquire("attempt:1", () => new FakeSession());
    const b = hub.acquire("player:x", () => new FakeSession());
    expect(a).not.toBe(b);
    hub.release("nothing");
    hub.release("attempt:1");
    hub.release("attempt:1");
    vi.advanceTimersByTime(RELEASE_DELAY_MS);
    expect(a.disposed).toBe(1);
    expect(b.disposed).toBe(0);
  });
});
