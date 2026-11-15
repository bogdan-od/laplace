import { describe, expect, it } from "vitest";
import { parsePlaySource, parseStartMs } from "./play-source";

describe("parsePlaySource", () => {
  it("reads the four kinds of source", () => {
    expect(parsePlaySource("branch-12")).toEqual({ kind: "branch", id: 12 });
    expect(parsePlaySource("submission-5-m1")).toEqual({ kind: "submission", id: 5, node: "m1" });
    expect(parsePlaySource("submission-5-pc-1")).toEqual({ kind: "submission", id: 5, node: "pc-1" });
    expect(parsePlaySource("item-3-srv-reference")).toEqual({ kind: "item", id: 3, node: "srv", role: "reference" });
    expect(parsePlaySource("item-3-m1-start")).toEqual({ kind: "item", id: 3, node: "m1", role: "start" });
    expect(parsePlaySource("embed-a1b2-C3")).toEqual({ kind: "embed", token: "a1b2-C3" });
  });

  it("refuses what is not a source", () => {
    for (const text of ["", "branch-", "branch-0", "branch-1x", "branch--1", "submission-5", "item-1-m1-other", "embed-", "nonsense", "x/branch-1"]) {
      expect(parsePlaySource(text), text).toBeNull();
    }
  });
});

describe("parseStartMs", () => {
  it("accepts whole milliseconds only", () => {
    expect(parseStartMs("0")).toBe(0);
    expect(parseStartMs("1534")).toBe(1534);
    for (const text of [null, "", "-5", "1.5", "abc", "1e3", "12345678901234"]) expect(parseStartMs(text), String(text)).toBeNull();
  });
});
