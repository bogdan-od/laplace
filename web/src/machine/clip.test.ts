import { describe, expect, it } from "vitest";
import { clipBody, clipProblem, CLIP_ERROR_ORDER, CLIP_ERROR_UNSET, defaultClipTitle, EMPTY_CLIP_RANGE } from "./clip";

const SOURCE = { branchId: 7, student: "Лисенко Ірина" };

describe("clipProblem", () => {
  it("wants both ends", () => {
    expect(clipProblem(EMPTY_CLIP_RANGE)).toBe(CLIP_ERROR_UNSET);
    expect(clipProblem({ startMs: 1000, endMs: null, endEvent: null })).toBe(CLIP_ERROR_UNSET);
  });

  it("refuses an end before the start", () => {
    expect(clipProblem({ startMs: 5000, endMs: 4000, endEvent: 3 })).toBe(CLIP_ERROR_ORDER);
  });

  it("refuses an empty interval", () => {
    expect(clipProblem({ startMs: 5000, endMs: 5000, endEvent: 3 })).toBe(CLIP_ERROR_ORDER);
  });

  it("accepts an end after the start", () => {
    expect(clipProblem({ startMs: 5000, endMs: 5001, endEvent: 3 })).toBeNull();
  });
});

describe("defaultClipTitle", () => {
  it("names the assignment, the student and the interval", () => {
    const range = { startMs: 65_000, endMs: 150_400, endEvent: 12 };
    expect(defaultClipTitle("Налаштування мережі", "Лисенко Ірина", range)).toBe("Налаштування мережі - Лисенко Ірина, 01:05-02:30");
  });
});

describe("clipBody", () => {
  it("is the request of the contract", () => {
    const range = { startMs: 65_000, endMs: 150_400, endEvent: 12 };
    expect(clipBody(SOURCE, range, "  Мій кліп ")).toEqual({ branch_id: 7, to_event: 12, from_ms: 65_000, title: "Мій кліп" });
  });

  it("throws for a range that cannot be saved", () => {
    expect(() => clipBody(SOURCE, { startMs: 5, endMs: 3, endEvent: 1 }, "x")).toThrow(CLIP_ERROR_ORDER);
  });
});
