import { describe, expect, test } from "vitest";
import type { Activity, ActivityKind } from "@shared/api";
import { activityAction, describeActivity } from "./activity-text";

const KINDS: Record<ActivityKind, string> = {
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

function activity(kind: string, patch: Partial<Activity> = {}): Activity {
  return {
    id: 1,
    class_id: 1,
    assignment_id: 5,
    actor: { id: 10, name: "Ткачук Мирослава" },
    student: null,
    kind: kind as ActivityKind,
    ref_id: null,
    text: null,
    at: 0,
    ...patch,
  };
}

describe("activityAction", () => {
  test.each(Object.entries(KINDS))("%s", (kind, text) => {
    expect(activityAction(kind)).toBe(text);
  });
  test("an unknown kind is shown as it is", () => {
    expect(activityAction("brand_new_kind")).toBe("brand_new_kind");
  });
});

describe("describeActivity", () => {
  const titles = (id: number) => (id === 5 ? "Мережі: ping" : undefined);

  test("assignment title comes from the class's assignments, the student only when it is not the actor", () => {
    const line = describeActivity(activity("graded", { actor: { id: 1, name: "Викладач" }, student: { id: 10, name: "Ткачук Мирослава" } }), titles);
    expect(line).toEqual({ action: "виставляє оцінку", note: null, student: "Ткачук Мирослава", assignment: "Мережі: ping" });
    expect(describeActivity(activity("submitted", { student: { id: 10, name: "Ткачук Мирослава" } }), titles).student).toBeNull();
  });
  test("help request keeps the student's text as a note and does not use it as a title", () => {
    const line = describeActivity(activity("help_requested", { text: "Не працює ping", assignment_id: 9 }), titles);
    expect(line.note).toBe("Не працює ping");
    expect(line.assignment).toBeNull();
  });
  test("a deleted assignment falls back to the title saved with the event", () => {
    expect(describeActivity(activity("submitted", { assignment_id: 9, text: "Старе завдання" }), titles).assignment).toBe("Старе завдання");
  });
  test("a class-level event has no assignment", () => {
    expect(describeActivity(activity("member_joined", { assignment_id: null }), titles).assignment).toBeNull();
  });
  test("an unknown kind still gives a line", () => {
    expect(describeActivity(activity("brand_new_kind"), titles).action).toBe("brand_new_kind");
  });
});
