import { describe, expect, test } from "vitest";
import type { Member } from "@shared/api";
import { groupMembers, lastSeenText } from "./member-view";

const NOW = new Date(2037, 10, 12, 15, 0).getTime();
const MINUTE = 60_000;

describe("lastSeenText", () => {
  test("never, just now, minutes ago", () => {
    expect(lastSeenText(null, NOW)).toBe("-");
    expect(lastSeenText(NOW - 20_000, NOW)).toBe("щойно");
    expect(lastSeenText(NOW - 12 * MINUTE, NOW)).toBe("12 хв тому");
  });
  test("an hour or more ago gives the time of day, an older day gives the date", () => {
    expect(lastSeenText(NOW - 90 * MINUTE, NOW)).toBe("13:30");
    expect(lastSeenText(NOW - 3 * 24 * 60 * MINUTE, NOW)).toContain("9 листопада");
  });
});

function member(id: number, role: Member["role"], number: number | null, name = `Учасник ${id}`): Member {
  return { user_id: id, name, login: `u${id}`, role, number, joined_at: 0, last_seen_at: null };
}

describe("groupMembers", () => {
  test("assistants are a separate group; students are ordered by number", () => {
    const { students, assistants } = groupMembers([member(3, "student", 2), member(4, "assistant", null, "Яценко"), member(5, "student", 1), member(6, "assistant", null, "Андрієнко")]);
    expect(students.map((m) => m.user_id)).toEqual([5, 3]);
    expect(assistants.map((m) => m.name)).toEqual(["Андрієнко", "Яценко"]);
  });
});
