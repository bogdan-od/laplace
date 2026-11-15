import { LogOut, PanelLeft, Search } from "lucide-react";
import { Link, NavLink } from "react-router";
import { useLogout } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { Me } from "@shared/api";
import { NotificationsBell } from "./Notifications";

const topLink = ({ isActive }: { isActive: boolean }) => cn(isActive && "font-medium text-foreground");

export function TopBar({
  me,
  navOpen,
  onToggleNav,
  onOpenSearch,
}: {
  me: Me;
  navOpen: boolean;
  onToggleNav: () => void;
  onOpenSearch: () => void;
}) {
  const { logout, pending } = useLogout();
  const teacher = me.role === "teacher";
  return (
    <header className="flex h-11 shrink-0 items-center gap-4 border-b bg-card px-3">
      <button
        type="button"
        onClick={onToggleNav}
        title={navOpen ? "Сховати меню" : "Показати меню"}
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PanelLeft className="size-4" />
      </button>
      <Link to="/" className="inline-flex items-center gap-2 font-display text-[17px] font-bold">
        <img src="/favicon.svg" alt="" className="size-[22px]" />
        Laplace
      </Link>
      {!navOpen && (
        <nav className="ml-2 flex gap-4 text-sm text-muted-foreground">
          {teacher ? (
            <>
              <NavLink to="/review" className={topLink}>
                На перевірку
              </NavLink>
              <NavLink to="/calendar" className={topLink}>
                Календар
              </NavLink>
              <NavLink to="/library" className={topLink}>
                Бібліотека
              </NavLink>
            </>
          ) : (
            <NavLink to="/" end className={topLink}>
              Мої завдання
            </NavLink>
          )}
        </nav>
      )}
      <div className="ml-auto flex items-center gap-3">
        {teacher && (
          <button
            type="button"
            onClick={onOpenSearch}
            className="flex h-7 w-56 items-center gap-2 rounded-md border bg-background px-2 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground"
          >
            <Search className="size-3.5" />
            Пошук
            <kbd className="ml-auto text-[12px]">Ctrl+K</kbd>
          </button>
        )}
        <NotificationsBell role={me.role} />
        <Link to="/settings" title="Налаштування" className="text-sm hover:underline">
          {me.name}
        </Link>
        <button
          type="button"
          onClick={() => void logout()}
          disabled={pending}
          title="Вийти"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </header>
  );
}
