import { describe, expect, it } from "vitest";
import type { CalendarEntry } from "@shared/api";
import {
  dayKey,
  entriesByDay,
  monthKey,
  monthTitle,
  monthWeeks,
  parseMonth,
  shiftMonth,
  visibleEntries,
  visibleRange,
  waitingText,
  weekdayNames,
} from "./calendar-grid";

function entry(id: number, due: Date, toReview = 0): CalendarEntry {
  return { assignment_id: id, title: `T${id}`, class_id: 1, class_name: "КН-21", due_at: due.getTime(), my_status: null, to_review: toReview };
}

describe("parseMonth", () => {
  const now = new Date(2037, 10, 13).getTime();

  it("reads ?m=YYYY-MM", () => {
    expect(parseMonth("2038-02", now)).toEqual({ year: 2038, month: 1 });
  });

  it("falls back to the month of now", () => {
    expect(parseMonth(null, now)).toEqual({ year: 2037, month: 10 });
    expect(parseMonth("2038-13", now)).toEqual({ year: 2037, month: 10 });
    expect(parseMonth("nonsense", now)).toEqual({ year: 2037, month: 10 });
  });

  it("round-trips with monthKey and shiftMonth crosses the year", () => {
    expect(monthKey(shiftMonth({ year: 2037, month: 11 }, 1))).toBe("2038-01");
    expect(monthKey(shiftMonth({ year: 2037, month: 0 }, -1))).toBe("2036-12");
  });
});

describe("monthWeeks", () => {
  it("starts every week on Monday", () => {
    for (const week of monthWeeks({ year: 2037, month: 10 })) expect(week[0]?.date.getDay()).toBe(1);
  });

  it("November 2037 (the 1st is a Sunday) has six rows and the 1st in the last column of the first", () => {
    const weeks = monthWeeks({ year: 2037, month: 10 });
    expect(weeks).toHaveLength(6);
    expect(weeks[0]?.[0]?.key).toBe("2037-10-26");
    expect(weeks[0]?.[6]).toMatchObject({ key: "2037-11-01", inMonth: true });
    expect(weeks[0]?.slice(0, 6).every((day) => !day.inMonth)).toBe(true);
    expect(weeks[5]?.at(-1)?.key).toBe("2037-12-06");
  });

  it("February 2038 (not a leap year, the 1st is a Monday) is exactly four weeks", () => {
    const weeks = monthWeeks({ year: 2038, month: 1 });
    expect(weeks).toHaveLength(4);
    expect(weeks[0]?.[0]).toMatchObject({ key: "2038-02-01", inMonth: true });
    expect(weeks[3]?.at(-1)?.key).toBe("2038-02-28");
    expect(weeks.flat().every((day) => day.inMonth)).toBe(true);
  });

  it("every day is the next one, also over the change of the clock", () => {
    const days = monthWeeks({ year: 2037, month: 9 }).flat();
    days.forEach((day, i) => {
      if (i > 0) expect(day.date.getDate()).not.toBe(days[i - 1]?.date.getDate());
      expect(day.key).toBe(dayKey(day.date));
    });
    expect(days.filter((day) => day.inMonth)).toHaveLength(31);
  });
});

describe("visibleRange", () => {
  it("covers the visible weeks as [from, to) in local midnights", () => {
    const { from, to } = visibleRange(monthWeeks({ year: 2037, month: 10 }));
    expect(from).toBe(new Date(2037, 9, 26).getTime());
    expect(to).toBe(new Date(2037, 11, 7).getTime());
  });
});

describe("entriesByDay", () => {
  it("puts a due time into the local day of the browser and sorts a day by time", () => {
    const late = entry(1, new Date(2037, 10, 5, 23, 59));
    const early = entry(2, new Date(2037, 10, 5, 8, 0));
    const next = entry(3, new Date(2037, 10, 6, 0, 0));
    const days = entriesByDay([late, next, early]);
    expect(days.get("2037-11-05")?.map((e) => e.assignment_id)).toEqual([2, 1]);
    expect(days.get("2037-11-06")?.map((e) => e.assignment_id)).toEqual([3]);
    expect(days.size).toBe(2);
  });
});

describe("visibleEntries", () => {
  const day = [1, 2, 3, 4, 5].map((id) => entry(id, new Date(2037, 10, 5, id)));

  it("shows up to three entries as they are", () => {
    expect(visibleEntries(day.slice(0, 3), false)).toEqual({ shown: day.slice(0, 3), hidden: 0 });
  });

  it("shows three and 'ще N' for more", () => {
    const { shown, hidden } = visibleEntries(day, false);
    expect(shown.map((e) => e.assignment_id)).toEqual([1, 2, 3]);
    expect(hidden).toBe(2);
  });

  it("shows all when expanded", () => {
    expect(visibleEntries(day, true)).toEqual({ shown: day, hidden: 0 });
  });
});

describe("texts", () => {
  it("agrees the waiting count", () => {
    expect(waitingText(1)).toBe("1 чекає перевірки");
    expect(waitingText(2)).toBe("2 чекають перевірки");
    expect(waitingText(11)).toBe("11 чекають перевірки");
    expect(waitingText(21)).toBe("21 чекає перевірки");
  });

  it("names the month and the days in Ukrainian, Monday first", () => {
    expect(monthTitle({ year: 2037, month: 10 })).toBe("Листопад 2037");
    expect(weekdayNames()).toEqual(["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"]);
  });
});
