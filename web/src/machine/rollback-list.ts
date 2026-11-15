// The list of places a student can roll back to: "До початку" and every command of their own.
// The index is where typing of the command began, so the command itself is undone.

import { commands, event_times, type Journal } from "@core/core/journal.mjs";

export interface RollbackOption {
  /** Event index to roll back to. */
  index: number;
  label: string;
  /** The command text; absent for "До початку". */
  text?: string;
  /** 1-based number among the student's own commands; absent for "До початку". */
  number?: number;
}

export const ROLLBACK_START_LABEL = "До початку";

const MS_PER_S = 1000;
const S_PER_MIN = 60;
const PAD = 2;

/** Guest time as mm:ss. */
export function formatGuestClock(ms: number): string {
  const seconds = Math.floor(ms / MS_PER_S);
  return `${String(Math.floor(seconds / S_PER_MIN)).padStart(PAD, "0")}:${String(seconds % S_PER_MIN).padStart(PAD, "0")}`;
}

/**
 * `startIndex` is where the student's work begins: the length of the assignment's start journal (the state
 * the teacher prepared), 0 without one. "До початку" goes there, not to a clean boot, and the commands of the
 * start journal are not offered.
 */
export function rollbackOptions(journal: Pick<Journal, "header" | "events">, startIndex: number): RollbackOption[] {
  const times = event_times(journal);
  const own = commands(journal.events).filter(
    (command) => command.by === "student" && command.port === 0 && command.start >= startIndex,
  );
  return [
    { index: startIndex, label: ROLLBACK_START_LABEL },
    ...own.map((command, i) => ({
      index: command.start,
      label: `${formatGuestClock(times[command.start] ?? 0)}  ${command.text}`,
      text: command.text,
      number: i + 1,
    })),
  ];
}
