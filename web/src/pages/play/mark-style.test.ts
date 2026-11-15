import { describe, expect, it } from "vitest";
import { MARK_KINDS, MARK_STYLE, hasBadge } from "./mark-style";

describe("mark styles", () => {
  it("a command is a tick, every rare event is a circle with its own icon and colour", () => {
    expect(hasBadge("command")).toBe(false);
    const events = MARK_KINDS.filter((kind) => kind !== "command");
    expect(events.every(hasBadge)).toBe(true);
    const icons = new Set(events.map((kind) => MARK_STYLE[kind].badge?.Icon));
    const fills = new Set(events.map((kind) => MARK_STYLE[kind].badge?.fill));
    expect(icons.size).toBe(events.length);
    expect(fills.size).toBe(events.length);
  });
});
