import { describe, expect, it, vi } from "vitest";
import { UNDO_MS } from "@shared/limits";
import { ApiFailure } from "./api";
import { deleteWithUndo, UNDO_LABEL, type UndoNotifier } from "./undo";

function notifier() {
  const actions: { message: string; label: string; onClick: () => void; durationMs: number }[] = [];
  const success = vi.fn<(message: string) => void>();
  const error = vi.fn<(message: string) => void>();
  const fake: UndoNotifier = {
    withAction: (message, action, durationMs) => actions.push({ message, durationMs, ...action }),
    success,
    error,
  };
  return { fake, actions, success, error };
}

describe("deleteWithUndo", () => {
  it("deletes at once and offers Скасувати for UNDO_MS; undo calls restore and refreshes", async () => {
    const { fake, actions, success } = notifier();
    const remove = vi.fn().mockResolvedValue(null);
    const restore = vi.fn().mockResolvedValue(null);
    const refresh = vi.fn();

    const done = await deleteWithUndo({ message: "Клас видалено", remove, restore, refresh, restoredMessage: "Клас відновлено" }, fake);
    expect(done).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ message: "Клас видалено", label: UNDO_LABEL, durationMs: UNDO_MS });

    actions[0]?.onClick();
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith("Клас відновлено"));
    expect(restore).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("shows the error and no undo when the delete fails", async () => {
    const { fake, actions, error } = notifier();
    const remove = vi.fn().mockRejectedValue(new ApiFailure(403, "Немає прав", undefined, null));
    const done = await deleteWithUndo({ message: "m", remove, restore: vi.fn() }, fake);
    expect(done).toBe(false);
    expect(actions).toHaveLength(0);
    expect(error).toHaveBeenCalledWith("Немає прав");
  });

  it("reports a failed undo", async () => {
    const { fake, actions, error } = notifier();
    const restore = vi.fn().mockRejectedValue(new ApiFailure(404, "Вже не можна відновити", undefined, null));
    await deleteWithUndo({ message: "m", remove: vi.fn().mockResolvedValue(null), restore }, fake);
    actions[0]?.onClick();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Вже не можна відновити"));
  });
});
