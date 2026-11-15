import { describe, expect, test } from "vitest";
import { sectionOf, withSection } from "./class-section";

describe("sectionOf", () => {
  test("known tabs", () => {
    expect(sectionOf("students")).toBe("students");
    expect(sectionOf("activity")).toBe("activity");
    expect(sectionOf("grades")).toBe("grades");
  });
  test("no parameter or garbage is the assignments", () => {
    expect(sectionOf(null)).toBe("assignments");
    expect(sectionOf("analytics")).toBe("assignments");
  });
});

describe("withSection", () => {
  test("keeps ?a= and the view", () => {
    expect(withSection(new URLSearchParams("a=3&view=table"), "grades").toString()).toBe("a=3&view=table&tab=grades");
  });
  test("returning to the assignments drops ?tab=", () => {
    expect(withSection(new URLSearchParams("a=3&tab=students"), "assignments").toString()).toBe("a=3");
  });
});
