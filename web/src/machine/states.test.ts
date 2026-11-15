import { describe, expect, it } from "vitest";
import {
  canType,
  cursorHidden,
  deriveState,
  overlayText,
  replayPercent,
  type MachineUiState,
  type StateInputs,
} from "./states";

const live = { mode: "live" as const, waiting: false, next: 5, total: 5 };
const replay = { mode: "replay" as const, waiting: false, next: 50, total: 200 };

function inputs(patch: Partial<StateInputs>): StateInputs {
  return { status: live, recovering: false, dead: false, frozen: false, ...patch };
}

describe("deriveState", () => {
  it("covers the table of states", () => {
    expect(deriveState(inputs({ status: null }))).toBe("starting");
    expect(deriveState(inputs({ status: { ...live, waiting: true } }))).toBe("waiting");
    expect(deriveState(inputs({ status: replay }))).toBe("restoring");
    expect(deriveState(inputs({}))).toBe("live");
    expect(deriveState(inputs({ recovering: true }))).toBe("recovering");
    expect(deriveState(inputs({ dead: true }))).toBe("failed");
    expect(deriveState(inputs({ frozen: true }))).toBe("frozen");
    expect(deriveState(inputs({ status: replay, context: "player" }))).toBe("replay");
  });

  it("a final failure wins over frozen, frozen wins over the rest", () => {
    expect(deriveState(inputs({ dead: true, frozen: true }))).toBe("failed");
    expect(deriveState(inputs({ frozen: true, recovering: true, status: replay }))).toBe("frozen");
  });
});

describe("input rule", () => {
  const states: MachineUiState[] = ["starting", "waiting", "restoring", "live", "recovering", "failed", "frozen", "replay"];

  it("accepts input only in the live state (and in starting for a new blank session)", () => {
    const accepting = states.filter((state) => canType(state, false));
    expect(accepting).toEqual(["live"]);
    expect(states.filter((state) => canType(state, true))).toEqual(["starting", "live"]);
  });

  it("drops input in replay and frozen", () => {
    expect(canType("replay", true)).toBe(false);
    expect(canType("frozen", true)).toBe(false);
  });

  it("hides the cursor while replaying", () => {
    expect(cursorHidden("restoring")).toBe(true);
    expect(cursorHidden("live")).toBe(false);
  });
});

describe("texts", () => {
  const details = { percent: 42, waitingTimedOut: false, error: null };

  it("uses the texts of the table", () => {
    expect(overlayText("starting", details)).toBe("Запускаємо машину…");
    expect(overlayText("waiting", details)).toBe("Завантажуємо файл образу…");
    expect(overlayText("waiting", { ...details, waitingTimedOut: true })).toBe(
      "Файл образу не відповідає. Перевірте, чи запущено сервер",
    );
    expect(overlayText("restoring", details)).toBe("Відновлюємо вашу сесію: 42%");
    expect(overlayText("recovering", details)).toBe("Машина перезапускається після збою…");
    expect(overlayText("failed", { ...details, error: "збій ядра" })).toBe("Машина зупинилась через помилку: збій ядра");
    expect(overlayText("frozen", details)).toBe("Викладач призупинив роботу");
    expect(overlayText("live", details)).toBeNull();
  });

  it("computes the percentage of replayed events", () => {
    expect(replayPercent(replay)).toBe(25);
    expect(replayPercent({ next: 0, total: 0 })).toBe(0);
    expect(replayPercent(null)).toBe(0);
    expect(replayPercent({ next: 300, total: 200 })).toBe(100);
  });
});
