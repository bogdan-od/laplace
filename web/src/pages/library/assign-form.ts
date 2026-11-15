import type { AssignBody, Topology } from "@shared/api";

export const DEFAULT_MAX_GRADE = 12;
/** server/src/assignments/dto.ts: MAX_GRADE_LIMIT. */
export const MAX_GRADE = 100;

export interface AssignForm {
  classId: number | null;
  /** The value of a datetime-local input: "2037-11-14T23:59" or "". */
  due: string;
  maxGrade: string;
  sharedLan: boolean;
}

export type AssignParse = { ok: true; body: AssignBody } | { ok: false; error: string };

/** The server accepts a shared network for one machine without links only. */
export function sharedLanAvailable(topology: Topology): boolean {
  return topology.machines.length === 1 && topology.links.length === 0;
}

export function parseAssignForm(form: AssignForm, topology: Topology): AssignParse {
  if (form.classId === null) return { ok: false, error: "Оберіть клас" };
  let dueAt: number | null = null;
  if (form.due !== "") {
    dueAt = new Date(form.due).getTime();
    if (Number.isNaN(dueAt)) return { ok: false, error: "Неправильний строк" };
  }
  const maxGrade = form.maxGrade.trim() === "" ? Number.NaN : Number(form.maxGrade);
  if (!Number.isInteger(maxGrade) || maxGrade < 1 || maxGrade > MAX_GRADE) {
    return { ok: false, error: `Максимум балів - ціле число від 1 до ${MAX_GRADE}` };
  }
  return {
    ok: true,
    body: { class_id: form.classId, due_at: dueAt, max_grade: maxGrade, shared_lan: form.sharedLan && sharedLanAvailable(topology) },
  };
}
