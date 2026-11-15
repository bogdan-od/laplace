import { describe, expect, it } from "vitest";
import type { CheckResult, CheckRun, ChunkInfo } from "@shared/api";
import { growthChart, mergeRun, parseGrade, runSummary, verifyLine, type ChartBox } from "./submission-view";

const BOX: ChartBox = { width: 400, height: 100, padding: { left: 10, right: 10, top: 10, bottom: 10 } };

function chunk(first: number, count: number, at: number): ChunkInfo {
  return { first_event: first, event_count: count, bytes: count * 20, received_at: at };
}

function result(rc: number | null): CheckResult {
  return { node: "m1", title: "t", command: "true", rc, output: "" };
}

function run(id: number, status: CheckRun["status"], results: CheckResult[] = [], message: string | null = null): CheckRun {
  return { id, submission_id: 1, status, results, message, created_at: 0, finished_at: null };
}

describe("growthChart", () => {
  it("has no chart without data", () => {
    expect(growthChart([], BOX)).toBeNull();
    expect(growthChart([{ node: "m1", chunks: [] }], BOX)).toBeNull();
  });

  it("puts a single chunk in the middle of the plot", () => {
    const chart = growthChart([{ node: "m1", chunks: [chunk(0, 50, 1000)] }], BOX);
    expect(chart?.maxEvents).toBe(50);
    expect(chart?.lines[0]?.points).toEqual([{ x: 200, y: 10, at: 1000, events: 50 }]);
    expect(chart?.lines[0]?.path).toBe("M200 10");
  });

  it("accumulates events and spreads chunks over server time", () => {
    const chart = growthChart([{ node: "m1", chunks: [chunk(50, 50, 3000), chunk(0, 50, 1000), chunk(100, 100, 2000)] }], BOX);
    const points = chart?.lines[0]?.points ?? [];
    // Arrival order, and the count never falls back when a late chunk covers earlier events.
    expect(points.map((point) => point.events)).toEqual([50, 200, 200]);
    expect(chart?.from).toBe(1000);
    expect(chart?.to).toBe(3000);
  });

  it("scales several machines by one time axis and one maximum", () => {
    const chart = growthChart(
      [
        { node: "m1", chunks: [chunk(0, 10, 0), chunk(10, 10, 100)] },
        { node: "m2", chunks: [chunk(0, 40, 50)] },
      ],
      BOX,
    );
    expect(chart?.maxEvents).toBe(40);
    expect(chart?.lines.map((line) => line.points.length)).toEqual([2, 1]);
    expect(chart?.lines[0]?.points.map((point) => point.x)).toEqual([10, 390]);
    expect(chart?.lines[1]?.points[0]).toMatchObject({ x: 200, y: 10 });
  });

  it("skips a machine without chunks and never goes below the baseline", () => {
    const chart = growthChart(
      [
        { node: "m1", chunks: [] },
        { node: "m2", chunks: [chunk(0, 0, 5)] },
      ],
      BOX,
    );
    expect(chart?.lines.map((line) => line.node)).toEqual(["m2"]);
    expect(chart?.lines[0]?.points[0]?.y).toBe(90);
  });
});

describe("verifyLine", () => {
  it("counts the matched checkpoints", () => {
    expect(verifyLine("ok", null, 1)).toBe("Журнал цілий: сервер повторив сесію, 1 команда збіглася");
    expect(verifyLine("ok", null, 3)).toBe("Журнал цілий: сервер повторив сесію, 3 команди збіглися");
    expect(verifyLine("ok", null, 5)).toBe("Журнал цілий: сервер повторив сесію, 5 команд збіглися");
  });

  it("falls back to the standard texts", () => {
    expect(verifyLine("ok", null, null)).toBe("Перевірку пройдено");
    expect(verifyLine("ok", null, 0)).toBe("Перевірку пройдено");
    expect(verifyLine("tail_unchecked", null, 4)).toBe("Частину після останньої перевірки не перевірено");
    expect(verifyLine("queued", null, null)).toBe("Перевіряється…");
  });

  it("shows the divergence message of a failed check", () => {
    expect(verifyLine("failed", "m1: розбіжність на події 7", 2)).toBe("m1: розбіжність на події 7");
    expect(verifyLine("timeout", null, 2)).toBe("Перевірка не пройшла");
  });
});

describe("check run text", () => {
  it("summarises every state", () => {
    expect(runSummary(run(1, "queued"), 3)).toBe("У черзі на перевірку…");
    expect(runSummary(run(1, "running", [result(0)]), 3)).toBe("Виконано 1 з 3");
    expect(runSummary(run(1, "done", [result(0), result(1), result(null)]), 3)).toBe("Пройдено 1 з 3");
    expect(runSummary(run(1, "done"), 3)).toBe("Пройдено 0 з 0");
    expect(runSummary(run(1, "failed", [], "Сервер перезапущено, перевірку перервано"), 3)).toBe("Сервер перезапущено, перевірку перервано");
    expect(runSummary(run(1, "failed"), 3)).toBe("Перевірку перервано");
  });

  it("merges snapshots: newer run, then further state, then more results", () => {
    const queued = run(2, "queued");
    const running = run(2, "running", [result(0)]);
    const more = run(2, "running", [result(0), result(0)]);
    const done = run(2, "done", [result(0), result(0)]);
    expect(mergeRun(null, queued)).toBe(queued);
    expect(mergeRun(queued, null)).toBe(queued);
    expect(mergeRun(running, queued)).toBe(running);
    expect(mergeRun(running, more)).toBe(more);
    expect(mergeRun(more, done)).toBe(done);
    expect(mergeRun(done, more)).toBe(done);
    expect(mergeRun(run(1, "done"), queued)).toBe(queued);
    expect(mergeRun(queued, run(1, "done"))).toBe(queued);
  });
});

describe("parseGrade", () => {
  it("rejects an empty field", () => {
    expect(parseGrade("", 10)).toEqual({ ok: false, error: "Введіть оцінку" });
    expect(parseGrade("   ", 10)).toEqual({ ok: false, error: "Введіть оцінку" });
  });

  it("rejects fractions and text", () => {
    expect(parseGrade("7,5", 10)).toEqual({ ok: false, error: "Оцінка має бути цілим числом" });
    expect(parseGrade("7.5", 10)).toEqual({ ok: false, error: "Оцінка має бути цілим числом" });
    expect(parseGrade("сім", 10).ok).toBe(false);
    expect(parseGrade("-1", 10).ok).toBe(false);
  });

  it("rejects a grade above the maximum", () => {
    expect(parseGrade("11", 10)).toEqual({ ok: false, error: "Оцінка не може перевищувати 10" });
  });

  it("accepts whole numbers from 0 to the maximum", () => {
    expect(parseGrade(" 8 ", 10)).toEqual({ ok: true, grade: 8 });
    expect(parseGrade("0", 10)).toEqual({ ok: true, grade: 0 });
    expect(parseGrade("10", 10)).toEqual({ ok: true, grade: 10 });
  });
});
