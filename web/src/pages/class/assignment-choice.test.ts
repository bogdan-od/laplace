import { describe, expect, it } from "vitest";
import type { AssignmentSummary } from "@shared/api";
import { chosenAssignment, defaultAssignment, groupAssignments } from "./assignment-choice";

const NOW = 1_000_000;

function assignment(id: number, due_at: number | null, created_at: number): AssignmentSummary {
  return { id, class_id: 1, kind: "task", title: `A${id}`, due_at, max_grade: 10, created_at, counts: {}, my_status: null, my_grade: null };
}

describe("default assignment", () => {
  it("is the nearest deadline that has not passed", () => {
    const list = [assignment(1, NOW - 10, 1), assignment(2, NOW + 500, 2), assignment(3, NOW + 100, 3), assignment(4, null, 4)];
    expect(defaultAssignment(list, NOW)?.id).toBe(3);
  });

  it("is the one given last when every deadline has passed or there are none", () => {
    expect(defaultAssignment([assignment(1, NOW - 10, 5), assignment(2, NOW - 20, 9), assignment(3, null, 7)], NOW)?.id).toBe(2);
    expect(defaultAssignment([assignment(1, null, 5), assignment(2, null, 5)], NOW)?.id).toBe(2);
  });

  it("is null without assignments", () => {
    expect(defaultAssignment([], NOW)).toBeNull();
  });

  it("gives way to a valid ?a= and ignores an unknown one", () => {
    const list = [assignment(1, NOW + 100, 1), assignment(2, NOW - 10, 2)];
    expect(chosenAssignment(list, "2", NOW)?.id).toBe(2);
    expect(chosenAssignment(list, "99", NOW)?.id).toBe(1);
    expect(chosenAssignment(list, null, NOW)?.id).toBe(1);
  });
});

describe("groupAssignments", () => {
  const list = [assignment(1, NOW - 10, 1), assignment(2, NOW + 500, 2), assignment(3, NOW + 100, 3), assignment(4, null, 4), assignment(5, NOW - 50, 5)];

  it("puts active ones first by deadline, those without a deadline last, and past ones by recency", () => {
    const { active, past } = groupAssignments(list, NOW, "");
    expect(active.map((a) => a.id)).toEqual([3, 2, 4]);
    expect(past.map((a) => a.id)).toEqual([1, 5]);
  });

  it("searches the title without regard to case", () => {
    const named = [{ ...assignment(1, null, 1), title: "Налаштування Мережі" }, { ...assignment(2, null, 2), title: "Урок" }];
    expect(groupAssignments(named, NOW, " мереж ").active.map((a) => a.id)).toEqual([1]);
    expect(groupAssignments(named, NOW, "xyz")).toEqual({ active: [], past: [] });
  });

  it("counts a deadline equal to now as active", () => {
    expect(groupAssignments([assignment(1, NOW, 1)], NOW, "").active).toHaveLength(1);
  });
});
