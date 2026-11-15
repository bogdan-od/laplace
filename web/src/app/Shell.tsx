import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useMatches } from "react-router";
import { Button } from "@/components/ui/button";
import { socket } from "@/lib/live";
import type { Me } from "@shared/api";
import { useNavOpen, type PageKind } from "./nav-state";
import { SearchDialog } from "./SearchDialog";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export interface RouteHandle {
  /** Kind of page for the menu memory; list pages open with the menu, work pages without it. */
  nav?: PageKind;
  /** A screen that takes the whole window: no top bar, no menu. It must give its own way back. */
  bare?: boolean;
}

function isRouteHandle(value: unknown): value is RouteHandle {
  return typeof value === "object" && value !== null;
}

function useNavKind(): PageKind {
  const matches = useMatches();
  for (const match of [...matches].reverse()) {
    if (isRouteHandle(match.handle) && match.handle.nav) return match.handle.nav;
  }
  return "list";
}

function useBare(): boolean {
  return useMatches().some((match) => isRouteHandle(match.handle) && match.handle.bare === true);
}

function ReplacedBanner() {
  const state = useSyncExternalStore(socket.subscribeState, socket.getState, socket.getState);
  if (state !== "replaced") return null;
  return (
    <div role="alert" className="flex items-center justify-center gap-3 border-b bg-status-work/15 px-4 py-2 text-sm">
      Ця сторінка відкрита в іншій вкладці
      <Button size="xs" variant="outline" onClick={() => location.reload()}>
        Відкрити тут
      </Button>
    </div>
  );
}

/** Menu + header around every signed-in page. */
export function Shell({ me }: { me: Me }) {
  const kind = useNavKind();
  const bare = useBare();
  const [navOpen, setNavOpen] = useNavOpen(kind);
  const [searching, setSearching] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (me.role !== "teacher") return;
    const onKey = (event: KeyboardEvent) => {
      // `code`, not `key`: on a Ukrainian layout the K key types "л".
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyK") {
        event.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [me.role]);

  useEffect(() => {
    socket.connect();
    const stop = socket.on("notify", () => {
      void queryClient.invalidateQueries({ queryKey: ["GET /api/notifications"] });
      void queryClient.invalidateQueries({ queryKey: ["GET /api/classes"] });
      void queryClient.invalidateQueries({ queryKey: ["GET /api/classes/:id"] });
      void queryClient.invalidateQueries({ queryKey: ["GET /api/me/assignments"] });
    });
    return () => {
      stop();
      socket.close();
    };
  }, [queryClient]);

  return (
    <div className="flex h-screen flex-col bg-background">
      <ReplacedBanner />
      {!bare && <TopBar me={me} navOpen={navOpen} onToggleNav={() => setNavOpen(!navOpen)} onOpenSearch={() => setSearching(true)} />}
      <div className="flex min-h-0 flex-1">
        {navOpen && !bare && <Sidebar role={me.role} />}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      {me.role === "teacher" && <SearchDialog open={searching} onOpenChange={setSearching} />}
    </div>
  );
}
