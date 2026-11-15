import type { StudentProgress, TileStatus } from "@shared/api";
import { plural } from "@/lib/format";

export const STATUS_ORDER: readonly TileStatus[] = ["stuck", "work", "done", "idle"];

export const STATUS_TEXT: Record<TileStatus, string> = {
  stuck: "Потрібна допомога",
  work: "Працює",
  done: "Здано",
  idle: "Не почали",
};

export const STATUS_TEXT_MANY: Record<TileStatus, string> = {
  stuck: "просять допомоги",
  work: "працюють",
  done: "здали",
  idle: "не почали",
};

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

export function countByStatus(students: readonly StudentProgress[]): Record<TileStatus, number> {
  const counts: Record<TileStatus, number> = { stuck: 0, work: 0, done: 0, idle: 0 };
  for (const student of students) counts[student.status] += 1;
  return counts;
}

/** Those who need help first, then by number in the class. */
export function sortStudents(students: readonly StudentProgress[]): StudentProgress[] {
  return [...students].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.number - b.number || a.user_id - b.user_id,
  );
}

/** Minutes from the start of the attempt to its last sign of life (the submission for a finished one). */
export function workMinutes(student: StudentProgress): number {
  if (student.started_at === null) return 0;
  const end = student.status === "done" ? (student.latest_submission?.created_at ?? student.last_activity_at) : student.last_activity_at;
  return end === null ? 0 : Math.max(0, Math.round((end - student.started_at) / MS_PER_MINUTE));
}

/** "щойно", "12 хв тому", "3 год тому". */
export function agoText(ms: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - ms) / MS_PER_MINUTE));
  if (minutes < 1) return "щойно";
  if (minutes < MINUTES_PER_HOUR) return `${minutes} хв тому`;
  return `${Math.floor(minutes / MINUTES_PER_HOUR)} год тому`;
}

export const commandsText = (n: number) => plural(n, "команда", "команди", "команд");
export const rollbacksText = (n: number) => plural(n, "відкат", "відкати", "відкатів");

export function studentHref(classId: number, assignmentId: number, student: StudentProgress): string {
  return `/classes/${classId}/assignments/${assignmentId}/students/${student.user_id}`;
}
