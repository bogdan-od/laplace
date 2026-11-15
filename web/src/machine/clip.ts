// The part of the clip dialog that needs no browser: the chosen interval, its check, the default title, the request.

import type { ClipBody } from "@shared/api";
import { formatGuestTime } from "./player-marks";

/** The ends chosen on the player: guest time of each, and the number of journal events up to the end. */
export interface ClipRange {
  startMs: number | null;
  endMs: number | null;
  endEvent: number | null;
}

export const EMPTY_CLIP_RANGE: ClipRange = { startMs: null, endMs: null, endEvent: null };

/** The branch a clip is cut from and the student it belongs to (for the default title). */
export interface ClipSource {
  branchId: number;
  student: string;
}

export const CLIP_ERROR_ORDER = "Кінець має бути пізніше за початок";
export const CLIP_ERROR_UNSET = "Позначте початок і кінець";

/** Why the range cannot be saved; null when it can. An empty interval (end = start) is not a clip. */
export function clipProblem(range: ClipRange): string | null {
  if (range.startMs === null || range.endMs === null || range.endEvent === null) return CLIP_ERROR_UNSET;
  return range.endMs > range.startMs ? null : CLIP_ERROR_ORDER;
}

/** "<assignment> - <student>, 01:05-02:30". */
export function defaultClipTitle(task: string, student: string, range: ClipRange): string {
  const from = formatGuestTime(range.startMs ?? 0);
  const to = formatGuestTime(range.endMs ?? 0);
  return `${task} - ${student}, ${from}-${to}`;
}

/** The request body; throws when the range is not valid (the button is off then, so this is a guard). */
export function clipBody(source: ClipSource, range: ClipRange, title: string): ClipBody {
  const problem = clipProblem(range);
  if (problem !== null || range.startMs === null || range.endEvent === null) throw new Error(problem ?? CLIP_ERROR_UNSET);
  return { branch_id: source.branchId, to_event: range.endEvent, from_ms: range.startMs, title: title.trim() };
}
