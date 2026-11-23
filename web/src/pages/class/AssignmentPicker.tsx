import { useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import type { AssignmentSummary } from "@shared/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { groupAssignments } from "./assignment-choice";

function Option({
  assignment,
  selected,
  now,
  onPick,
}: {
  assignment: AssignmentSummary;
  selected: boolean;
  now: number;
  onPick: (id: number) => void;
}) {
  return (
    <button
      type="button"
      data-testid="assignment-option"
      data-assignment={assignment.id}
      aria-current={selected}
      onClick={() => onPick(assignment.id)}
      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted", selected && "bg-muted font-medium")}
    >
      <Check className={cn("size-3.5 shrink-0", !selected && "invisible")} />
      <span className="min-w-0 flex-1 truncate">{assignment.title}</span>
      {assignment.due_at !== null && <span className="shrink-0 text-[13px] text-muted-foreground">{formatDate(assignment.due_at, now)}</span>}
    </button>
  );
}

function Group({
  title,
  items,
  selectedId,
  now,
  onPick,
}: {
  title: string;
  items: readonly AssignmentSummary[];
  selectedId: number | null;
  now: number;
  onPick: (id: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-2 pt-1 text-[13px] font-semibold text-muted-foreground">{title}</p>
      {items.map((assignment) => (
        <Option key={assignment.id} assignment={assignment} selected={assignment.id === selectedId} now={now} onPick={onPick} />
      ))}
    </div>
  );
}

/** "Завдання: ... v": every assignment of the class in a list with search, active ones on top. */
export function AssignmentPicker({
  assignments,
  selected,
  now,
  onSelect,
}: {
  assignments: readonly AssignmentSummary[];
  selected: AssignmentSummary;
  now: number;
  onSelect: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { active, past } = groupAssignments(assignments, now, query);
  const pick = (id: number) => {
    setOpen(false);
    onSelect(id);
  };
  const first = active[0] ?? past[0];
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" data-testid="assignment-picker" className="min-w-0 max-w-xl shrink justify-start">
          <span className="text-muted-foreground">Завдання:</span>
          <span data-testid="assignment-picker-title" className="truncate">{selected.title}</span>
          <ChevronDown className="ml-auto" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-[28rem] w-[28rem] max-w-[calc(100vw-2rem)] flex-col gap-1 p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && first) pick(first.id);
            }}
            placeholder="Знайти завдання"
            data-testid="assignment-search"
            className="pl-8"
          />
        </div>
        <div className="flex flex-col gap-1 overflow-y-auto">
          <Group title="Активні" items={active} selectedId={selected.id} now={now} onPick={pick} />
          <Group title="Минулі" items={past} selectedId={selected.id} now={now} onPick={pick} />
          {active.length + past.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">Нічого не знайдено</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
