import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, CalendarDays, CircleAlert, Inbox, ListChecks, Plus, Settings } from "lucide-react";
import { NavLink } from "react-router";
import { apiQuery } from "@/lib/query";
import { classStatus, type ClassCounter } from "@/lib/class-status";
import { cn } from "@/lib/utils";
import type { ClassSummary, Role } from "@shared/api";
import { CreateClassDialog } from "./CreateClassDialog";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted hover:text-foreground",
    isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
  );

function MenuLink({ to, icon: Icon, label, count }: { to: string; icon: typeof Inbox; label: string; count?: number }) {
  return (
    <NavLink to={to} end className={linkClass}>
      <Icon className="size-4" />
      {label}
      {count !== undefined && count > 0 && <span className="ml-auto text-[13px] tabular-nums">{count}</span>}
    </NavLink>
  );
}

const COUNTER_ICON = { help: CircleAlert, review: Inbox } as const;

function Counter({ counter }: { counter: ClassCounter }) {
  const Icon = COUNTER_ICON[counter.kind];
  return (
    <span
      title={counter.label}
      aria-label={counter.label}
      data-counter={counter.kind}
      className={cn("inline-flex items-center gap-1 tabular-nums", counter.kind === "help" ? "text-status-stuck" : "text-muted-foreground")}
    >
      <Icon className="size-3.5" aria-hidden />
      {counter.count}
    </span>
  );
}

function ClassList({ classes }: { classes: ClassSummary[] | undefined }) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center px-2 pb-1">
        <span className="text-[13px] text-muted-foreground">Мої класи</span>
        <button
          type="button"
          title="Створити клас"
          onClick={() => setCreating(true)}
          className="ml-auto inline-flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {classes?.length === 0 && (
        <p className="px-2 py-1 text-[13px] text-muted-foreground">
          Ще немає класів.{" "}
          <button type="button" onClick={() => setCreating(true)} className="text-primary hover:underline">
            Створіть перший клас
          </button>
          , щоб отримати код запрошення для студентів.
        </p>
      )}
      {classes?.map((c) => {
        const status = classStatus(c);
        return (
          <NavLink
            key={c.id}
            to={`/classes/${c.id}`}
            className={({ isActive }) =>
              cn(
                "flex flex-col rounded-md px-2 py-1.5",
                isActive ? "bg-primary/8 shadow-[inset_3px_0_0_var(--primary)]" : "hover:bg-muted",
              )
            }
          >
            <span className="truncate">
              <span className="font-medium">{c.name}</span>
              {c.subject && <span className="text-muted-foreground"> {c.subject}</span>}
            </span>
            {status.counters.length > 0 ? (
              <span className="flex gap-3 text-[13px]">
                {status.counters.map((counter) => (
                  <Counter key={counter.kind} counter={counter} />
                ))}
              </span>
            ) : (
              <span className="truncate text-[13px] text-muted-foreground">{status.note}</span>
            )}
          </NavLink>
        );
      })}
      <CreateClassDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

export function Sidebar({ role }: { role: Role }) {
  const classes = useQuery({ ...apiQuery("GET /api/classes"), enabled: role === "teacher" });
  const waiting = (classes.data ?? []).reduce((sum, c) => sum + c.to_review + c.open_help, 0);
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r bg-card px-3 py-4">
      {role === "teacher" ? (
        <>
          <div className="flex flex-col gap-0.5">
            <MenuLink to="/review" icon={Inbox} label="На перевірку" count={waiting} />
            <MenuLink to="/calendar" icon={CalendarDays} label="Календар" />
            <MenuLink to="/library" icon={BookOpen} label="Бібліотека" />
          </div>
          <ClassList classes={classes.data} />
        </>
      ) : (
        <div className="flex flex-col gap-0.5">
          <MenuLink to="/" icon={ListChecks} label="Мої завдання" />
        </div>
      )}
      <div className="mt-auto">
        <MenuLink to="/settings" icon={Settings} label="Налаштування" />
      </div>
    </nav>
  );
}
