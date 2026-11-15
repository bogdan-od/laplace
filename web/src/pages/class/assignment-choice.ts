import type { AssignmentSummary } from "@shared/api";

/** The nearest deadline that has not passed; when there is none, the assignment given last. */
export function defaultAssignment(assignments: readonly AssignmentSummary[], now: number): AssignmentSummary | null {
  let upcoming: AssignmentSummary | null = null;
  let latest: AssignmentSummary | null = null;
  for (const assignment of assignments) {
    if (assignment.due_at !== null && assignment.due_at >= now && (upcoming === null || assignment.due_at < (upcoming.due_at ?? Infinity))) {
      upcoming = assignment;
    }
    if (latest === null || assignment.created_at > latest.created_at || (assignment.created_at === latest.created_at && assignment.id > latest.id)) {
      latest = assignment;
    }
  }
  return upcoming ?? latest;
}

/** The assignment named by `?a=` when the class has it, otherwise the default one. */
export function chosenAssignment(
  assignments: readonly AssignmentSummary[],
  param: string | null,
  now: number,
): AssignmentSummary | null {
  const wanted = param === null ? undefined : assignments.find((assignment) => String(assignment.id) === param);
  return wanted ?? defaultAssignment(assignments, now);
}

export interface AssignmentGroups {
  /** Not past due, nearest deadline first; those without a deadline go last. */
  active: AssignmentSummary[];
  /** Past due, the most recent deadline first. */
  past: AssignmentSummary[];
}

/** The assignments whose title contains `query`, split into active and past for the picker. */
export function groupAssignments(assignments: readonly AssignmentSummary[], now: number, query: string): AssignmentGroups {
  const needle = query.trim().toLowerCase();
  const found = assignments.filter((assignment) => assignment.title.toLowerCase().includes(needle));
  const isPast = (assignment: AssignmentSummary) => assignment.due_at !== null && assignment.due_at < now;
  const active = found
    .filter((assignment) => !isPast(assignment))
    .sort((a, b) => (a.due_at ?? Infinity) - (b.due_at ?? Infinity) || b.created_at - a.created_at || b.id - a.id);
  const past = found.filter(isPast).sort((a, b) => (b.due_at ?? 0) - (a.due_at ?? 0) || b.id - a.id);
  return { active, past };
}
