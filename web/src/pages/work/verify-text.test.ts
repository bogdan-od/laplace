import { describe, expect, it } from "vitest";
import type { SubmissionSummary } from "@shared/api";
import { submissionState } from "./verify-text";

const state = (verify_status: SubmissionSummary["verify_status"], checks: SubmissionSummary["checks"]) =>
  submissionState({ verify_status, checks });

describe("submissionState", () => {
  it("shows the replay status when the journal did not pass or there is no check result", () => {
    expect(state("ok", null)).toEqual({ text: "Перевірку пройдено", tone: "text-status-done" });
    expect(state("failed", { passed: 3, total: 3 })).toEqual({ text: "Перевірка не пройшла", tone: "text-status-stuck" });
    expect(state("queued", { passed: 1, total: 3 }).text).toBe("Перевіряється…");
    expect(state("tail_unchecked", { passed: 3, total: 3 }).tone).toBe("text-status-work");
  });

  it("colours the check result: all green, some warning, none red", () => {
    expect(state("ok", { passed: 3, total: 3 })).toEqual({ text: "Перевірки 3/3", tone: "text-status-done" });
    expect(state("ok", { passed: 1, total: 3 })).toEqual({ text: "Перевірки 1/3", tone: "text-status-work" });
    expect(state("ok", { passed: 0, total: 3 })).toEqual({ text: "Перевірки 0/3", tone: "text-status-stuck" });
  });
});
