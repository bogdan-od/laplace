// What `/play/:source` names: a branch, a submission machine, a library item journal or an
// embed token. Parsing is pure.

import type { JournalRole } from "@shared/api";

export type PlaySource =
  | { kind: "branch"; id: number }
  | { kind: "submission"; id: number; node: string }
  | { kind: "item"; id: number; node: string; role: JournalRole }
  | { kind: "embed"; token: string };

const BRANCH = /^branch-([1-9]\d*)$/;
const SUBMISSION = /^submission-([1-9]\d*)-([\w.-]+)$/;
const ITEM = /^item-([1-9]\d*)-([\w.-]+)-(start|reference)$/;
const EMBED = /^embed-([\w-]+)$/;
const MS = /^\d{1,12}$/;

export function parsePlaySource(text: string): PlaySource | null {
  const branch = BRANCH.exec(text);
  if (branch) return { kind: "branch", id: Number(branch[1]) };
  const submission = SUBMISSION.exec(text);
  if (submission) return { kind: "submission", id: Number(submission[1]), node: submission[2] ?? "" };
  const item = ITEM.exec(text);
  if (item) return { kind: "item", id: Number(item[1]), node: item[2] ?? "", role: item[3] === "start" ? "start" : "reference" };
  const embed = EMBED.exec(text);
  if (embed) return { kind: "embed", token: embed[1] ?? "" };
  return null;
}

/** `?t=<guest ms>`; anything that is not a whole number of milliseconds means "from the start". */
export function parseStartMs(value: string | null): number | null {
  return value !== null && MS.test(value) ? Number(value) : null;
}
