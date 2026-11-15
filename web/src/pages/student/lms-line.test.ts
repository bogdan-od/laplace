import { describe, expect, it } from "vitest";
import { lmsLine } from "./lms-line";

describe("lmsLine", () => {
  it("is absent for a student who did not come through LTI", () => {
    expect(lmsLine(null)).toBeNull();
  });

  it("says the grade was passed", () => {
    expect(lmsLine({ status: "sent", error: null, sent_at: 1 })).toBe("LMS: оцінку передано");
  });

  it("gives the reason of a failed transfer", () => {
    expect(lmsLine({ status: "failed", error: "Платформа відповіла помилкою 500 на передачу оцінки", sent_at: null })).toBe(
      "LMS: не передано - Платформа відповіла помилкою 500 на передачу оцінки",
    );
    expect(lmsLine({ status: "failed", error: null, sent_at: null })).toBe("LMS: не передано");
  });

  it("says a grade that is not set yet was not passed", () => {
    expect(lmsLine({ status: "pending", error: null, sent_at: null })).toBe("LMS: оцінка передається…");
  });
});
