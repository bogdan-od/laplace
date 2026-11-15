import type { CheckCommand, Hint, LibraryItem, PatchItemBody, Topology } from "@shared/api";
import { MAX_BRIEF_CHARS, MAX_CHECKS, MAX_COMMAND_CHARS, MAX_HINTS, MAX_TEXT_CHARS, MAX_TITLE_CHARS } from "@shared/limits";

import { orphanChecks, parseTopologyText, topologyText } from "./topology-text";

/** server/src/content/dto.ts: MAX_HINT_PENALTY. */
export const MAX_HINT_PENALTY = 100;

/** The penalty stays text while it is typed. */
export interface HintRow {
  text: string;
  penalty: string;
}

export interface CheckRow {
  node: string;
  title: string;
  command: string;
}

export interface ItemForm {
  brief: string;
  /** The text of the editor, valid or not. */
  topology: string;
  hints: HintRow[];
  checks: CheckRow[];
}

/** `topology` is present only when the form holds a valid one that differs from the saved one. */
export type FormPatch = Required<Pick<PatchItemBody, "brief" | "hints" | "checks">> & Pick<PatchItemBody, "topology">;

export function formOf(item: LibraryItem): ItemForm {
  return {
    brief: item.brief,
    topology: topologyText(item.topology),
    hints: item.hints.map((hint) => ({ text: hint.text, penalty: String(hint.penalty) })),
    checks: item.checks.map((check) => ({ ...check })),
  };
}

function penaltyOf(row: HintRow): number {
  return row.penalty.trim() === "" ? 0 : Number(row.penalty);
}

function validPenalty(penalty: number): boolean {
  return Number.isInteger(penalty) && penalty >= 0 && penalty <= MAX_HINT_PENALTY;
}

function changedTopology(form: ItemForm, item: LibraryItem): Topology | null {
  const { topology } = parseTopologyText(form.topology);
  return topology !== null && JSON.stringify(topology) !== JSON.stringify(item.topology) ? topology : null;
}

/** The body of the PATCH: rows without a text or a command are dropped, a check without a title is named by its command. */
export function patchBody(form: ItemForm, item: LibraryItem): FormPatch {
  const hints: Hint[] = form.hints
    .filter((row) => row.text.trim() !== "")
    .map((row) => ({ text: row.text.trim(), penalty: penaltyOf(row) }));
  const checks: CheckCommand[] = form.checks
    .filter((row) => row.command.trim() !== "")
    .map((row) => {
      const command = row.command.trim();
      return { node: row.node, title: row.title.trim() || command.slice(0, MAX_TITLE_CHARS), command };
    });
  const topology = changedTopology(form, item);
  return { brief: form.brief, hints, checks, ...(topology ? { topology } : {}) };
}

/** The first thing that stops the form from being saved, or null. */
export function formProblem(form: ItemForm, item: LibraryItem): string | null {
  const body = patchBody(form, item);
  if (form.brief.length > MAX_BRIEF_CHARS) return `Умова - не більше ${MAX_BRIEF_CHARS} символів`;
  if (body.hints.length > MAX_HINTS) return `Підказок - не більше ${MAX_HINTS}`;
  if (body.checks.length > MAX_CHECKS) return `Команд перевірки - не більше ${MAX_CHECKS}`;
  const shown = form.hints.filter((row) => row.text.trim() !== "");
  for (const [index, row] of shown.entries()) {
    if (row.text.trim().length > MAX_TEXT_CHARS) return `Підказка ${index + 1}: не більше ${MAX_TEXT_CHARS} символів`;
    if (!validPenalty(penaltyOf(row))) return `Підказка ${index + 1}: штраф - ціле число від 0 до ${MAX_HINT_PENALTY}`;
  }
  if (body.checks.some((check) => check.command.length > MAX_COMMAND_CHARS)) {
    return `Команда перевірки - не більше ${MAX_COMMAND_CHARS} символів`;
  }
  const draft = parseTopologyText(form.topology);
  if (draft.topology === null) return `Топологія: ${draft.problems[0] ?? "помилка в описі"}`;
  const orphan = orphanChecks(body.checks, draft.topology.machines)[0];
  if (orphan) return `Перевірка "${orphan.title}": машини "${orphan.node}" немає в топології`;
  return null;
}

/** True when saving would change the item. */
export function isDirty(form: ItemForm, item: LibraryItem): boolean {
  const saved = formOf(item);
  if (JSON.stringify(patchBody(form, item)) !== JSON.stringify(patchBody(saved, item))) return true;
  return form.topology !== saved.topology && parseTopologyText(form.topology).topology === null;
}

/** A copy of the rows with the one at `index` moved by `delta`; out of range returns the rows unchanged. */
export function moveRow<T>(rows: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  const copy = [...rows];
  const row = copy[index];
  if (row === undefined || target < 0 || target >= copy.length) return copy;
  copy.splice(index, 1);
  copy.splice(target, 0, row);
  return copy;
}
