// Text and target of a notification. Texts avoid past-tense verbs about people: gender is not stored.

import type { Activity, ActivityKind, Role } from "@shared/api";

const KIND_TEXT: Record<ActivityKind, (a: Activity) => string> = {
  member_joined: (a) => `Новий студент у класі: ${a.actor.name}`,
  assignment_created: () => "Нове завдання",
  attempt_opened: (a) => `${a.actor.name} відкриває завдання`,
  help_requested: (a) => `${a.actor.name}: "У мене не працює"${a.text ? ` - ${a.text}` : ""}`,
  help_resolved: () => "Запит \"не працює\" закрито",
  help_replied: () => "Викладач відповідає на запит \"не працює\"",
  submitted: (a) => `Нова здача: ${a.actor.name}`,
  verify_failed: (a) => `Перевірка здачі не пройшла: ${(a.student ?? a.actor).name}`,
  graded: () => "Виставлено оцінку",
  commented: () => "Новий коментар до здачі",
  hint_used: (a) => `${a.actor.name} відкриває підказку`,
};

export function activityText(activity: Activity): string {
  return KIND_TEXT[activity.kind](activity);
}

const STUDENT_PAGE_KINDS = new Set<ActivityKind>(["help_requested", "submitted", "verify_failed", "attempt_opened"]);

/** Where a notification leads: the student's page for requests and submissions, else the class or the task. */
export function activityHref(activity: Activity, role: Role): string {
  if (role === "student") return activity.assignment_id === null ? "/" : `/assignments/${activity.assignment_id}`;
  if (activity.assignment_id !== null && activity.student && STUDENT_PAGE_KINDS.has(activity.kind)) {
    return `/classes/${activity.class_id}/assignments/${activity.assignment_id}/students/${activity.student.id}`;
  }
  return activity.assignment_id === null
    ? `/classes/${activity.class_id}`
    : `/classes/${activity.class_id}?a=${activity.assignment_id}`;
}
