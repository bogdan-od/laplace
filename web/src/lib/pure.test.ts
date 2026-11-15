import { describe, expect, it } from "vitest";
import type { Activity, ClassSummary, SearchResult } from "@shared/api";
import { activityHref, activityText } from "./activity";
import { classStatus } from "./class-status";
import { plural } from "./format";
import { groupsOf } from "./search";
import { checkLogin, checkNewPassword, splitFieldMessage } from "./validate";

const base: ClassSummary = {
  id: 1, name: "КН-21", subject: "", my_role: "owner", students: 24, to_review: 0, open_help: 0, next_due_at: null, is_demo: false,
};

describe("plural", () => {
  it("picks the Ukrainian form", () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25].map((n) => plural(n, "здача", "здачі", "здач"))).toEqual([
      "1 здача", "2 здачі", "5 здач", "11 здач", "12 здач", "21 здача", "22 здачі", "25 здач",
    ]);
  });
});

describe("classStatus", () => {
  it("gives short counters with full phrases for the tooltip, help first", () => {
    expect(classStatus({ ...base, open_help: 2, to_review: 3 }).counters).toEqual([
      { kind: "help", count: 2, label: "2 запити \"не працює\"" },
      { kind: "review", count: 3, label: "3 здачі на перевірку" },
    ]);
  });
  it("has no counters for a quiet class and falls back to the student count", () => {
    expect(classStatus(base)).toEqual({ counters: [], note: "24 студенти" });
  });
  it("names the nearest deadline as the note", () => {
    const status = classStatus({ ...base, next_due_at: Date.UTC(2037, 10, 14) });
    expect(status.note).toContain("Найближчий строк 14 листопада");
  });
});

describe("validate", () => {
  it("checks login and password with the contract limits", () => {
    expect(checkLogin(" Ivan.P ")).toBeUndefined();
    expect(checkLogin("ab")).toContain("3-32");
    expect(checkLogin("")).toBe("Введіть логін");
    expect(checkNewPassword("1234567")).toContain("8");
    expect(checkNewPassword("12345678")).toBeUndefined();
  });
  it("splits the server's field message", () => {
    expect(splitFieldMessage("Поле login: має неприпустимий формат")).toEqual({ field: "login", text: "має неприпустимий формат" });
    expect(splitFieldMessage("Невірний пароль")).toBeNull();
  });
});

describe("notifications", () => {
  const activity: Activity = {
    id: 9, class_id: 3, assignment_id: 7, actor: { id: 5, name: "Іван Петренко" }, student: { id: 5, name: "Іван Петренко" },
    kind: "help_requested", ref_id: 1, text: "не бачу мережу", at: 0,
  };
  it("writes text without past tense and routes by role", () => {
    expect(activityText(activity)).toBe("Іван Петренко: \"У мене не працює\" - не бачу мережу");
    expect(activityHref(activity, "teacher")).toBe("/classes/3/assignments/7/students/5");
    expect(activityHref(activity, "student")).toBe("/assignments/7");
    expect(activityHref({ ...activity, kind: "graded" }, "teacher")).toBe("/classes/3?a=7");
  });
});

describe("search groups", () => {
  it("numbers hits across groups and drops empty groups", () => {
    const result: SearchResult = {
      classes: [{ id: 1, name: "КН-21" }],
      students: [],
      assignments: [{ id: 7, title: "VLAN", class_id: 1, class_name: "КН-21" }],
      library: [{ id: 4, kind: "task", title: "Маршрутизація" }],
    };
    const groups = groupsOf(result);
    expect(groups.map((g) => g.title)).toEqual(["Класи", "Завдання", "Бібліотека"]);
    expect(groups.flatMap((g) => g.hits.map((h) => [h.index, h.href]))).toEqual([
      [0, "/classes/1"], [1, "/classes/1?a=7"], [2, "/library/4"],
    ]);
  });
});
