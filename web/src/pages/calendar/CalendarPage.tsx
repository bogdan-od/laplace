import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import type { CalendarEntry } from "@shared/api";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/api";
import { formatClock } from "@/lib/format";
import { apiQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import {
  dayKey,
  entriesByDay,
  monthKey,
  monthTitle,
  monthWeeks,
  parseMonth,
  shiftMonth,
  visibleEntries,
  VISIBLE_ENTRIES,
  visibleRange,
  waitingText,
  weekdayNames,
  type Day,
  type Month,
} from "./calendar-grid";

function EntryLink({ entry, testId = "calendar-entry" }: { entry: CalendarEntry; testId?: string }) {
  return (
    <Link
      to={`/classes/${entry.class_id}?a=${entry.assignment_id}`}
      data-testid={testId}
      data-assignment={entry.assignment_id}
      className="flex flex-col rounded-md border bg-background px-2 py-1 text-[13px] hover:bg-muted"
    >
      <span className="truncate font-medium">{entry.title}</span>
      <span className="truncate text-muted-foreground">
        {entry.class_name}, {formatClock(entry.due_at)}
      </span>
      {entry.to_review > 0 && <span className="text-status-work">{waitingText(entry.to_review)}</span>}
    </Link>
  );
}

interface DayCellProps {
  day: Day;
  entries: readonly CalendarEntry[];
  today: string;
  expanded: boolean;
  onToggle: () => void;
}

function DayCell({ day, entries, today, expanded, onToggle }: DayCellProps) {
  const { shown, hidden } = visibleEntries(entries, expanded);
  return (
    <div
      data-testid="calendar-day"
      data-day={day.key}
      className={cn("flex min-h-28 min-w-0 flex-col gap-1 bg-card p-1.5", !day.inMonth && "bg-muted/40 text-muted-foreground")}
    >
      <span
        className={cn("self-start text-[13px] tabular-nums", day.key === today && "rounded-full bg-primary px-1.5 font-medium text-primary-foreground")}
      >
        {day.date.getDate()}
      </span>
      {shown.map((entry) => (
        <EntryLink key={entry.assignment_id} entry={entry} />
      ))}
      {entries.length > VISIBLE_ENTRIES && (
        <button type="button" data-testid="calendar-more" onClick={onToggle} className="self-start text-[13px] text-primary hover:underline">
          {expanded ? "згорнути" : `ще ${hidden}`}
        </button>
      )}
    </div>
  );
}

const AGENDA_DAY = new Intl.DateTimeFormat("uk", { weekday: "long", day: "numeric", month: "long" });

/** The month on a narrow screen: the days that have due dates, one under another. */
function Agenda({ weeks, byDay }: { weeks: readonly (readonly Day[])[]; byDay: ReadonlyMap<string, readonly CalendarEntry[]> }) {
  const days = weeks.flat().filter((day) => day.inMonth && (byDay.get(day.key)?.length ?? 0) > 0);
  if (days.length === 0) return <p className="rounded-lg border bg-card px-3 py-4 text-sm text-muted-foreground md:hidden">Термінів у цьому місяці немає</p>;
  return (
    <div data-testid="calendar-agenda" className="flex flex-col gap-3 md:hidden">
      {days.map((day) => (
        <section key={day.key} className="flex flex-col gap-1.5 rounded-lg border bg-card p-2.5">
          <h2 className="text-sm font-medium first-letter:uppercase">{AGENDA_DAY.format(day.date)}</h2>
          {(byDay.get(day.key) ?? []).map((entry) => (
            <EntryLink key={entry.assignment_id} entry={entry} testId="calendar-agenda-entry" />
          ))}
        </section>
      ))}
    </div>
  );
}

/** "/calendar": the due dates of my classes by month, Monday first. */
export function CalendarPage() {
  const [search, setSearch] = useSearchParams();
  const [now] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const month = parseMonth(search.get("m"), now);
  const weeks = monthWeeks(month);
  const { from, to } = visibleRange(weeks);
  const entries = useQuery({ ...apiQuery("GET /api/calendar", { query: { from, to } }), placeholderData: keepPreviousData });
  const byDay = entriesByDay(entries.data ?? []);
  const today = dayKey(new Date(now));

  const go = (target: Month) => setSearch({ m: monthKey(target) });
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 sm:px-6 py-6" data-testid="calendar-page">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-[26px] leading-tight font-bold">Календар</h1>
        <Button variant="outline" size="icon" aria-label="Попередній місяць" data-testid="calendar-prev" onClick={() => go(shiftMonth(month, -1))}>
          <ChevronLeft />
        </Button>
        <Button variant="outline" data-testid="calendar-today" onClick={() => setSearch({})}>
          Сьогодні
        </Button>
        <Button variant="outline" size="icon" aria-label="Наступний місяць" data-testid="calendar-next" onClick={() => go(shiftMonth(month, 1))}>
          <ChevronRight />
        </Button>
        <span className="text-base font-medium" data-testid="calendar-month" data-month={monthKey(month)}>
          {monthTitle(month)}
        </span>
        <Button variant="outline" asChild className="ml-auto">
          <a href="/api/calendar.ics" download="laplace.ics" data-testid="calendar-ics">
            <Download /> Завантажити .ics
          </a>
        </Button>
      </div>
      {entries.error && (
        <EmptyState
          title={describeError(entries.error)}
          action={<Button variant="outline" onClick={() => void entries.refetch()}>Спробувати знову</Button>}
        />
      )}
      <Agenda weeks={weeks} byDay={byDay} />
      <div className="hidden grid-cols-7 gap-px overflow-hidden rounded-lg border bg-border md:grid" data-testid="calendar-grid">
        {weekdayNames().map((name) => (
          <div key={name} className="bg-muted px-2 py-1.5 text-[13px] font-medium text-muted-foreground">
            {name}
          </div>
        ))}
        {weeks.flat().map((day) => (
          <DayCell key={day.key} day={day} entries={byDay.get(day.key) ?? []} today={today} expanded={expanded.has(day.key)} onToggle={() => toggle(day.key)} />
        ))}
      </div>
    </div>
  );
}
