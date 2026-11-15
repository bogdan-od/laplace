// The states a machine shows on screen, the rule for what typing does in each, and their texts.
// Pure functions: the session feeds them, tests call them directly.

import type { MachineStatus } from "@core/core/engine.mjs";

export type MachineUiState =
  | "starting" // loading the boot snapshot, starting the Worker
  | "waiting" // the Worker waits for an image file
  | "restoring" // replay to the live mode (restore, rollback, task start journal)
  | "live"
  | "recovering" // restored after a Worker failure
  | "failed" // final failure: the machine does not run, the journal up to it is kept
  | "frozen" // paused by the teacher
  | "replay"; // player only: the journal is played, not lived

export type UiContext = "attempt" | "player";

export interface StateInputs {
  status: Pick<MachineStatus, "mode" | "waiting" | "next" | "total"> | null;
  recovering: boolean;
  dead: boolean;
  frozen: boolean;
  context?: UiContext;
}

/** When `waiting` lasts this long, the text blames the server. */
export const WAITING_TIMEOUT_MS = 30_000;

const PERCENT = 100;

/** Order matters: a dead machine is dead even when frozen; frozen hides everything else but the failure. */
export function deriveState(inputs: StateInputs): MachineUiState {
  if (inputs.dead) return "failed";
  if (inputs.frozen) return "frozen";
  if (inputs.recovering) return "recovering";
  const { status } = inputs;
  if (status === null) return "starting";
  if (status.waiting === true) return "waiting";
  if (status.mode === "replay") return inputs.context === "player" ? "replay" : "restoring";
  return "live";
}

/** Share of the journal events already replayed, 0..100. */
export function replayPercent(status: Pick<MachineStatus, "next" | "total"> | null): number {
  if (status === null || status.total <= 0) return 0;
  return Math.min(PERCENT, Math.max(0, Math.floor((status.next / status.total) * PERCENT)));
}

/**
 * Whether typing in the terminal reaches the machine. Before the first status only a new blank session
 * accepts input (the Machine queues it); with a journal it would be lost, so it is refused.
 */
export function canType(state: MachineUiState, freshSession: boolean): boolean {
  if (state === "live") return true;
  return state === "starting" && freshSession;
}

export interface TextDetails {
  percent: number;
  waitingTimedOut: boolean;
  error: string | null;
}

/** Text over the terminal; null when nothing should be shown. */
export function overlayText(state: MachineUiState, details: TextDetails): string | null {
  switch (state) {
    case "starting":
      return "Запускаємо машину…";
    case "waiting":
      return details.waitingTimedOut
        ? "Файл образу не відповідає. Перевірте, чи запущено сервер"
        : "Завантажуємо файл образу…";
    case "restoring":
      return `Відновлюємо вашу сесію: ${details.percent}%`;
    case "recovering":
      return "Машина перезапускається після збою…";
    case "failed":
      return details.error ? `Машина зупинилась через помилку: ${details.error}` : "Машина зупинилась через помилку";
    case "frozen":
      return "Викладач призупинив роботу";
    case "live":
    case "replay":
      return null;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

/** The cursor is hidden while the machine replays: it would blink where nobody can type. */
export function cursorHidden(state: MachineUiState): boolean {
  return state === "restoring" || state === "replay";
}
