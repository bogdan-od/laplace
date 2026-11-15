import type { RuntimeView } from "@/machine/machine-runtime";
import type { MachineUiState } from "@/machine/states";

export type Tone = "done" | "work" | "stuck" | "idle";

/** Text colour of a tone. */
export const TONE_TEXT: Record<Tone, string> = {
  done: "text-status-done",
  work: "text-status-work",
  stuck: "text-status-stuck",
  idle: "text-muted-foreground",
};

export const TONE_DOT: Record<Tone, string> = {
  done: "bg-status-done",
  work: "bg-status-work",
  stuck: "bg-status-stuck",
  idle: "bg-status-idle",
};

/** Fill and outline of a box on the diagram. */
export const TONE_BOX: Record<Tone, string> = {
  done: "fill-status-done/15 stroke-status-done",
  work: "fill-status-work/15 stroke-status-work",
  stuck: "fill-status-stuck/15 stroke-status-stuck",
  idle: "fill-status-idle/15 stroke-status-idle",
};

export interface MachineStatus {
  tone: Tone;
  text: string;
}

/** What the status of a machine needs from its runtime view; the teacher's page has no runtime and passes just these. */
export type StatusView = Pick<RuntimeView, "state" | "percent">;

/** The teacher's page when the student is not in the room. */
export const OFFLINE_STATUS: MachineStatus = { tone: "idle", text: "Не в мережі" };

/** The diagram of a topology nobody runs. */
export const QUIET_STATUS: MachineStatus = { tone: "idle", text: "" };

const STATE_TONE: Record<MachineUiState, Tone> = {
  starting: "work",
  waiting: "work",
  restoring: "work",
  live: "done",
  recovering: "work",
  failed: "stuck",
  frozen: "idle",
  replay: "work",
};

/** The state of a machine as a colour and a word; a machine the session has not created yet is loading. */
export function machineStatus(view: StatusView | undefined): MachineStatus {
  if (view === undefined) return { tone: "work", text: "Завантаження" };
  const tone = STATE_TONE[view.state];
  switch (view.state) {
    case "starting":
      return { tone, text: "Запуск" };
    case "waiting":
      return { tone, text: "Завантаження образу" };
    case "restoring":
      return { tone, text: `Відновлення ${Math.round(view.percent)}%` };
    case "live":
      return { tone, text: "Працює" };
    case "recovering":
      return { tone, text: "Перезапуск після збою" };
    case "failed":
      return { tone, text: "Збій" };
    case "frozen":
      return { tone, text: "Призупинено" };
    case "replay":
      return { tone, text: "Відтворення" };
    default: {
      const unreachable: never = view.state;
      return unreachable;
    }
  }
}
