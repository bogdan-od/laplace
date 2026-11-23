import { LogOut, Menu, PanelLeft, Search } from "lucide-react";
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
    <header className="flex h-11 shrink-0 items-center gap-3 border-b bg-card px-3 md:gap-4">
      <button
        type="button"
        onClick={onToggleNav}
        title={navOpen ? "Сховати меню" : "Показати меню"}
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PanelLeft className="hidden size-4 lg:block" />
        <Menu className="size-4 lg:hidden" />
      </button>
      <Link to="/" className="inline-flex items-center gap-2 font-display text-[17px] font-bold">
        <img src="/favicon.svg" alt="" className="size-[22px]" />
        Laplace
      </Link>
      {!navOpen && (
        <nav className="ml-2 hidden gap-4 text-sm text-muted-foreground lg:flex">
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
            title="Пошук"
            className="flex h-7 w-7 items-center justify-center gap-2 rounded-md border bg-background text-sm whitespace-nowrap text-muted-foreground hover:text-foreground md:w-56 md:justify-start md:px-2"
          >
            <Search className="size-3.5" />
            <span className="hidden md:inline">Пошук</span>
            <kbd className="ml-auto hidden text-[12px] md:inline">Ctrl+K</kbd>
          </button>
        )}
        <NotificationsBell role={me.role} />
        <Link to="/settings" title="Налаштування" className="hidden text-sm hover:underline md:inline">
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
