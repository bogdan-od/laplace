import { describe, expect, it } from "vitest";
import { statusText } from "./status-text";

describe("statusText", () => {
  it("says 'Здано' for a finished task and 'Пройдено' for a lesson", () => {
    expect(statusText("done")).toBe("Здано");
    expect(statusText("done", "task")).toBe("Здано");
    expect(statusText("done", "lesson")).toBe("Пройдено");
  });

  it("keeps the other words for both kinds", () => {
    expect(statusText("work", "lesson")).toBe("В роботі");
    expect(statusText("idle", "task")).toBe("Не розпочато");
    expect(statusText("stuck", "lesson")).toBe("Потрібна допомога");
  });
});
