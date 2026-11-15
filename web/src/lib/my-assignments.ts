// The student's list "Мої завдання": assignments of all classes in one order.

import type { AssignmentSummary } from "@shared/api";

/** Not yet handed in, due later: first. Then without a due date, then overdue, then handed in. */
const GROUP = { upcoming: 0, undated: 1, overdue: 2, done: 3 } as const;

function groupOf(item: AssignmentSummary, now: number): number {
  if (item.my_status === "done") return GROUP.done;
  if (item.due_at === null) return GROUP.undated;
  return item.due_at > now ? GROUP.upcoming : GROUP.overdue;
}

/** Handed-in work: newer due date first, no due date last. */
function newestDueFirst(a: AssignmentSummary, b: AssignmentSummary): number {
  return (b.due_at ?? -Infinity) - (a.due_at ?? -Infinity) || 0;
}

export function sortMyAssignments<T extends AssignmentSummary>(items: readonly T[], now: number): T[] {
  return [...items].sort((a, b) => {
    const groups = groupOf(a, now) - groupOf(b, now);
    if (groups !== 0) return groups;
    const byDue =
      groupOf(a, now) === GROUP.done ? newestDueFirst(a, b) : (a.due_at ?? 0) - (b.due_at ?? 0);
    return byDue || b.created_at - a.created_at || a.id - b.id;
  });
}

export function isOverdue(item: AssignmentSummary, now: number): boolean {
  return item.my_status !== "done" && item.due_at !== null && item.due_at <= now;
}
