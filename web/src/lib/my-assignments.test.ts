import { describe, expect, it } from "vitest";
import type { TileStatus } from "@shared/api";
import type { MyAssignment } from "@shared/api";
import { isOverdue, sortMyAssignments } from "./my-assignments";

const NOW = 1_000_000;
const DAY = 86_400_000;

function item(id: number, due: number | null, status: TileStatus | null = "idle", created = id): MyAssignment {
  return {
    id,
    class_id: 1,
    class_name: "КН-21",
    kind: "task",
    title: `T${id}`,
    due_at: due,
    max_grade: 100,
    created_at: created,
    counts: {},
    my_status: status,
    my_grade: null,
    frozen: false,
  };
}

const ids = (list: readonly MyAssignment[]) => list.map((entry) => entry.id);

describe("sortMyAssignments", () => {
  it("puts upcoming first by due date, then undated, then overdue, then handed in", () => {
    const list = [
      item(1, NOW - DAY),
      item(2, null),
      item(3, NOW + 2 * DAY),
      item(4, NOW + DAY),
      item(5, NOW + DAY, "done"),
      item(6, NOW + 3 * DAY, "done"),
      item(7, NOW - 2 * DAY),
    ];
    expect(ids(sortMyAssignments(list, NOW))).toEqual([4, 3, 2, 7, 1, 6, 5]);
  });

  it("treats a missing status as not handed in and keeps handed-in without a date last", () => {
    const list = [item(1, null, "done"), item(2, NOW + DAY, null), item(3, NOW - 1, "done")];
    expect(ids(sortMyAssignments(list, NOW))).toEqual([2, 3, 1]);
  });

  it("breaks ties by the newer assignment and does not change the input", () => {
    const list = [item(1, NOW + DAY, "idle", 5), item(2, NOW + DAY, "idle", 9)];
    expect(ids(sortMyAssignments(list, NOW))).toEqual([2, 1]);
    expect(ids(list)).toEqual([1, 2]);
  });

  it("counts a due date equal to now as overdue", () => {
    expect(isOverdue(item(1, NOW), NOW)).toBe(true);
    expect(isOverdue(item(1, NOW, "done"), NOW)).toBe(false);
    expect(isOverdue(item(1, null), NOW)).toBe(false);
  });
});
