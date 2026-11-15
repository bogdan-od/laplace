import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, CalendarDays, Inbox, PanelLeft, Search, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { CLASS_INFO } from "./data";

/*
 * Pages that list things (classes, "to review", library) open with the menu; pages where the
 * teacher works with an assignment or a student open without it, because the table and the
 * terminal need the width. The teacher's choice is remembered separately for each kind.
 */
export type PageKind = "list" | "work";

const navKey = (kind: PageKind) => `mock.nav-open.${kind}`;

const MY_CLASSES = [
  { id: "kn21", name: "КН-21", subject: "Комп'ютерні мережі", note: "живе заняття", live: true },
  { id: "kn22", name: "КН-22", subject: "Комп'ютерні мережі", note: "Лаб. 5 до 14 листопада" },
  { id: "kn31", name: "КН-31", subject: "Операційні системи", note: "3 здачі на перевірку" },
  { id: "ipz11", name: "ІПЗ-11", subject: "Основи Linux", note: "Лаб. 2 до 18 листопада" },
];

function NavLink({ icon: Icon, label, count }: { icon: typeof Inbox; label: string; count?: number }) {
  return (
    <a href="#" className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
      <Icon className="size-4" />
      {label}
      {count !== undefined && <span className="ml-auto text-[13px] tabular-nums">{count}</span>}
    </a>
  );
}

function Sidebar() {
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r bg-card px-3 py-4">
      <div className="flex flex-col gap-0.5">
        <NavLink icon={Inbox} label="На перевірку" count={5} />
        <NavLink icon={CalendarDays} label="Календар" />
        <NavLink icon={BookOpen} label="Бібліотека" />
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="px-2 pb-1 text-[13px] text-muted-foreground">Мої класи</span>
        {MY_CLASSES.map((c) => (
          <a
            key={c.id}
            href="#"
            className={cn(
              "flex flex-col rounded-md px-2 py-1.5",
              c.name === CLASS_INFO.name ? "bg-primary/8 shadow-[inset_3px_0_0_var(--primary)]" : "hover:bg-muted",
            )}
          >
            <span className="truncate">
              <span className="font-medium">{c.name}</span>{" "}
              <span className="text-muted-foreground">{c.subject}</span>
            </span>
            <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              {c.live && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
              {c.note}
            </span>
          </a>
        ))}
      </div>
      <div className="mt-auto">
        <NavLink icon={Settings} label="Налаштування" />
      </div>
    </nav>
  );
}

function TopBar({ navOpen, onToggle }: { navOpen: boolean; onToggle: () => void }) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-4 border-b bg-card px-3">
      <button
        onClick={onToggle}
        title={navOpen ? "Сховати меню" : "Показати меню"}
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PanelLeft className="size-4" />
      </button>
      <a href="#" className="font-display text-[17px] font-bold">
        Laplace
      </a>
      {!navOpen && (
        <nav className="ml-2 flex gap-4 text-sm text-muted-foreground">
          <a href="#" className="font-medium text-foreground">
            Класи
          </a>
          <a>На перевірку</a>
          <a>Бібліотека</a>
        </nav>
      )}
      <div className="ml-auto flex items-center gap-3">
        <div className="flex h-7 w-56 items-center gap-2 rounded-md border bg-background px-2 text-sm whitespace-nowrap text-muted-foreground">
          <Search className="size-3.5" />
          Пошук
          <kbd className="ml-auto text-[12px]">Ctrl+K</kbd>
        </div>
        <span className="text-sm">{CLASS_INFO.teacher}</span>
      </div>
    </header>
  );
}

function readNav(kind: PageKind): boolean {
  const saved = localStorage.getItem(navKey(kind));
  return saved === null ? kind === "list" : saved === "1";
}

export function Shell({ kind, children }: { kind: PageKind; children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(() => readNav(kind));
  useEffect(() => setNavOpen(readNav(kind)), [kind]);
  const toggle = () => {
    localStorage.setItem(navKey(kind), navOpen ? "0" : "1");
    setNavOpen(!navOpen);
  };
  return (
    <div className="flex h-screen flex-col bg-background">
      <TopBar navOpen={navOpen} onToggle={toggle} />
      <div className="flex min-h-0 flex-1">
        {navOpen && <Sidebar />}
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
