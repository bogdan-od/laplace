import { describe, expect, it } from "vitest";
import type { HelpRequest, ReviewItem } from "@shared/api";
import { filterReview, reviewClasses, reviewKey, reviewTarget, reviewWhen, sortReview } from "./review-list";

const NOW = 100 * 86_400_000;
const MINUTE = 60_000;

function submission(id: number, at: number, classId = 1): ReviewItem {
  return {
    kind: "submission",
    submission: { id, attempt_id: id, created_at: at, verify_status: "ok", grade: null, checks: null },
    assignment: { id: 20 + id, title: `Завдання ${id}` },
    class: { id: classId, name: classId === 1 ? "КН-21" : "АБ-11" },
    student: { id: 300 + id, name: `Студент ${id}` },
  };
}

function help(id: number, at: number, classId = 1): ReviewItem {
  const request: HelpRequest = {
    id,
    attempt_id: 5,
    assignment_id: 21,
    class_id: classId,
    student: { id: 301, name: "Студент 1" },
    node: "m1",
    branch_id: 77,
    event_count: 12,
    text: "Не працює",
    created_at: at,
    resolved_at: null,
    reply_branch_id: null,
  };
  return { kind: "help", help: request, assignment: { id: 21, title: "Завдання 1" }, class: { id: classId, name: classId === 1 ? "КН-21" : "АБ-11" } };
}

describe("sortReview", () => {
  it("puts the newest first and breaks ties by id", () => {
    const items = [submission(1, 100), help(9, 300), submission(3, 200), submission(2, 200)];
    expect(sortReview(items).map(reviewKey)).toEqual(["help-9", "submission-3", "submission-2", "submission-1"]);
  });

  it("does not change the argument", () => {
    const items = [submission(1, 100), submission(2, 200)];
    sortReview(items);
    expect(items.map(reviewKey)).toEqual(["submission-1", "submission-2"]);
  });
});

describe("filterReview", () => {
  const items = [submission(1, 100), help(1, 200), submission(2, 300, 2), help(2, 400, 2)];

  it("keeps everything for 'all' and no class", () => {
    expect(filterReview(items, "all", null).map(reviewKey)).toEqual(["help-2", "submission-2", "help-1", "submission-1"]);
  });

  it("filters by kind", () => {
    expect(filterReview(items, "submission", null).map(reviewKey)).toEqual(["submission-2", "submission-1"]);
    expect(filterReview(items, "help", null).map(reviewKey)).toEqual(["help-2", "help-1"]);
  });

  it("filters by class together with the kind", () => {
    expect(filterReview(items, "all", 2).map(reviewKey)).toEqual(["help-2", "submission-2"]);
    expect(filterReview(items, "help", 1).map(reviewKey)).toEqual(["help-1"]);
  });
});

describe("reviewClasses", () => {
  it("lists each class once, by name", () => {
    const items = [submission(1, 1, 1), help(1, 2, 2), submission(2, 3, 1)];
    expect(reviewClasses(items)).toEqual([{ id: 2, name: "АБ-11" }, { id: 1, name: "КН-21" }]);
  });
});

describe("reviewTarget", () => {
  it("leads a submission to the panel of the student", () => {
    expect(reviewTarget(submission(4, 1))).toEqual({ kind: "page", href: "/classes/1/assignments/24/students/304?submission=4" });
  });

  it("leads a help request to the player with its reply", () => {
    const item = help(8, 1);
    expect(reviewTarget(item)).toEqual({ kind: "moment", help: item.kind === "help" ? item.help : undefined });
  });
});

describe("reviewWhen", () => {
  it("is relative within a day", () => {
    expect(reviewWhen(NOW - 12 * MINUTE, NOW)).toBe("12 хв тому");
    expect(reviewWhen(NOW - 5 * 60 * MINUTE, NOW)).toBe("5 год тому");
  });

  it("is a date after a day", () => {
    expect(reviewWhen(NOW - 2 * 86_400_000, NOW)).toMatch(/\d{2}:\d{2}$/);
  });
});
