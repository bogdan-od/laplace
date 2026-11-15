import type { Activity, ActivityKind } from "@shared/api";

// Present tense: the actor's gender is not stored, and past-tense verbs would have to guess it.
const ACTION: Record<ActivityKind, string> = {
  member_joined: "приєднується до класу",
  assignment_created: "видає завдання",
  attempt_opened: "відкриває завдання",
  help_requested: "просить допомоги",
  help_resolved: "закриває запит допомоги",
  help_replied: "відповідає на запит допомоги",
  submitted: "здає роботу",
  verify_failed: "перевірка здачі не пройшла",
  graded: "виставляє оцінку",
  commented: "коментує здачу",
  hint_used: "відкриває підказку",
};

/** The text for a kind; a kind this client does not know is shown as it is. */
export function activityAction(kind: string): string {
  return (ACTION as Record<string, string | undefined>)[kind] ?? kind;
}

export interface ActivityLine {
  action: string;
  /** What the student wrote with a help request. */
  note: string | null;
  student: string | null;
  assignment: string | null;
}

/** `titleOf` finds the assignment's title; the activity's own `text` is the title at the time of the event. */
export function describeActivity(activity: Activity, titleOf: (id: number) => string | undefined): ActivityLine {
  const known = activity.assignment_id === null ? undefined : titleOf(activity.assignment_id);
  const fallback = activity.assignment_id !== null && activity.kind !== "help_requested" ? activity.text : null;
  return {
    action: activityAction(activity.kind),
    note: activity.kind === "help_requested" ? activity.text : null,
    student: activity.student && activity.student.id !== activity.actor.id ? activity.student.name : null,
    assignment: activity.assignment_id === null ? null : (known ?? fallback),
  };
}
