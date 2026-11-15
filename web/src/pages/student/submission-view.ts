import type { CheckRun, ChunkInfo, Ms, Submission, VerifyStatus } from "@shared/api";
import { plural } from "@/lib/format";
import { VERIFY_TEXT } from "@/pages/work/verify-text";

export interface GrowthPoint {
  x: number;
  y: number;
  /** Server time the chunk arrived and the journal length after it, for the tooltip. */
  at: Ms;
  events: number;
}

export interface GrowthLine {
  node: string;
  points: GrowthPoint[];
  path: string;
}

export interface GrowthChart {
  lines: GrowthLine[];
  from: Ms;
  to: Ms;
  maxEvents: number;
}

export interface ChartBox {
  width: number;
  height: number;
  /** Space kept free on every side for the axis labels. */
  padding: { left: number; right: number; top: number; bottom: number };
}

/** How the journal of each machine grew: x is the server time a chunk arrived, y the events held after it. */
export function growthChart(growth: Submission["growth"], box: ChartBox): GrowthChart | null {
  const series = growth
    .map(({ node, chunks }) => ({ node, steps: cumulative(chunks) }))
    .filter(({ steps }) => steps.length > 0);
  if (series.length === 0) return null;
  const times = series.flatMap(({ steps }) => steps.map((step) => step.at));
  const from = Math.min(...times);
  const to = Math.max(...times);
  const maxEvents = Math.max(1, ...series.flatMap(({ steps }) => steps.map((step) => step.events)));
  const plotWidth = box.width - box.padding.left - box.padding.right;
  const plotHeight = box.height - box.padding.top - box.padding.bottom;
  const lines = series.map(({ node, steps }) => {
    const points = steps.map((step) => ({
      // One instant (a single chunk, or all chunks together): the point goes to the middle.
      x: box.padding.left + (to === from ? plotWidth / 2 : ((step.at - from) / (to - from)) * plotWidth),
      y: box.padding.top + plotHeight - (step.events / maxEvents) * plotHeight,
      at: step.at,
      events: step.events,
    }));
    const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${round(point.x)} ${round(point.y)}`).join(" ");
    return { node, points, path };
  });
  return { lines, from, to, maxEvents };
}

function cumulative(chunks: readonly ChunkInfo[]): { at: Ms; events: number }[] {
  const ordered = [...chunks].sort((a, b) => a.received_at - b.received_at || a.first_event - b.first_event);
  let events = 0;
  return ordered.map((chunk) => {
    events = Math.max(events, chunk.first_event + chunk.event_count);
    return { at: chunk.received_at, events };
  });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The line under "Перевірка журналу": what the server found when it replayed the session. */
export function verifyLine(status: VerifyStatus, message: string | null, commands: number | null): string {
  if (status === "ok" && commands !== null && commands > 0) {
    const points = plural(commands, "команда збіглася", "команди збіглися", "команд збіглися");
    return `Журнал цілий: сервер повторив сесію, ${points}`;
  }
  if ((status === "failed" || status === "timeout") && message) return message;
  return VERIFY_TEXT[status];
}

const RUN_RANK: Record<CheckRun["status"], number> = { queued: 0, running: 1, done: 2, failed: 2 };

/** Of two snapshots of the check runs keeps the newer run, and of one run the more advanced snapshot. */
export function mergeRun(current: CheckRun | null, incoming: CheckRun | null): CheckRun | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  if (incoming.id !== current.id) return incoming.id > current.id ? incoming : current;
  const rank = RUN_RANK[incoming.status] - RUN_RANK[current.status];
  if (rank !== 0) return rank > 0 ? incoming : current;
  return incoming.results.length >= current.results.length ? incoming : current;
}

export function passedChecks(run: CheckRun): number {
  return run.results.filter((result) => result.rc === 0).length;
}

/** The text of a check run's state; `expected` is how many commands the task has. */
export function runSummary(run: CheckRun, expected: number): string {
  switch (run.status) {
    case "queued":
      return "У черзі на перевірку…";
    case "running":
      return `Виконано ${run.results.length} з ${Math.max(expected, run.results.length)}`;
    case "done":
      return `Пройдено ${passedChecks(run)} з ${run.results.length}`;
    case "failed":
      return run.message ?? "Перевірку перервано";
  }
}

export function runFinished(run: CheckRun | null): boolean {
  return run === null || run.status === "done" || run.status === "failed";
}

export type GradeInput = { ok: true; grade: number } | { ok: false; error: string };

/** The grade field: a whole number from 0 to the assignment's maximum (the server accepts nothing else). */
export function parseGrade(text: string, max: number): GradeInput {
  const value = text.trim();
  if (value === "") return { ok: false, error: "Введіть оцінку" };
  if (/^\d+[.,]\d+$/.test(value)) return { ok: false, error: "Оцінка має бути цілим числом" };
  if (!/^\d+$/.test(value)) return { ok: false, error: `Оцінка - ціле число від 0 до ${max}` };
  const grade = Number(value);
  if (grade > max) return { ok: false, error: `Оцінка не може перевищувати ${max}` };
  return { ok: true, grade };
}
