import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Link } from "react-router";
import type { Assignment } from "@shared/api";
import { formatDue } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BACK_TEXT } from "./texts";

/** The title line of the work screen; `children` go to its right end. */
export function WorkHeader({ assignment, overdue, children }: { assignment: Assignment; overdue: boolean; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <Link to="/" className="text-sm text-primary hover:underline">
        {BACK_TEXT}
      </Link>
      <h1 className="font-display text-[22px] leading-tight font-bold">{assignment.title}</h1>
      <span className="text-sm text-muted-foreground">{assignment.class_name}</span>
      {assignment.due_at !== null && (
        <span className={cn("text-sm tabular-nums", overdue ? "text-status-stuck" : "text-muted-foreground")}>
          Строк: {formatDue(assignment.due_at)}
        </span>
      )}
      <span className="ml-auto">{children}</span>
    </header>
  );
}

export function Brief({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <section className="rounded-lg border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-sm font-semibold"
        data-testid="brief-toggle"
      >
        <Icon className="size-4" />
        Умова
      </button>
      {open && (
        <p data-testid="brief" className="max-h-40 overflow-y-auto px-3 pb-3 text-sm whitespace-pre-wrap">
          {text}
        </p>
      )}
    </section>
  );
}
