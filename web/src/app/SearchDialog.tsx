import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ApiFailure, describeError } from "@/lib/api";
import { apiQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { groupsOf, type Hit } from "@/lib/search";

const MIN_QUERY_CHARS = 2;
const DEBOUNCE_MS = 250;

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose={false} className="top-[12vh] max-w-xl gap-0 p-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Пошук</DialogTitle>
        <SearchPanel onPick={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function SearchPanel({ onPick }: { onPick: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const query = useDebounced(text.trim(), DEBOUNCE_MS);
  const enabled = query.length >= MIN_QUERY_CHARS;
  const search = useQuery({ ...apiQuery("GET /api/search", { query: { q: query } }), enabled });

  // The route may not exist yet on the server; a 404 is the same as no results.
  const notFound = search.error instanceof ApiFailure && search.error.status === 404;
  const groups = groupsOf(search.data);
  const flat = groups.flatMap((group) => group.hits);
  const current = Math.min(active, Math.max(flat.length - 1, 0));

  const open = (hit: Hit | undefined) => {
    if (!hit) return;
    onPick();
    void navigate(hit.href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(current + 1, flat.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      open(flat[current]);
    }
  };

  let status: string | null = null;
  if (!enabled) status = `Введіть щонайменше ${MIN_QUERY_CHARS} символи`;
  else if (query !== text.trim() || search.isPending) status = "Шукаємо…";
  else if (search.error && !notFound) status = describeError(search.error);
  else if (flat.length === 0) status = "Нічого не знайдено";

  return (
    <div onKeyDown={onKeyDown}>
      <input
        autoFocus
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
        }}
        placeholder="Клас, студент, завдання, предмет бібліотеки"
        aria-label="Пошук"
        className="h-12 w-full border-b bg-transparent px-4 text-base outline-none placeholder:text-muted-foreground"
      />
      <div className="max-h-[50vh] overflow-y-auto py-1" role="listbox">
        {status ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{status}</p>
        ) : (
          groups.map((group) => (
            <div key={group.title} className="py-1">
              <p className="flex items-center gap-1.5 px-4 py-1 text-[13px] text-muted-foreground">
                <group.icon className="size-3.5" />
                {group.title}
              </p>
              {group.hits.map((hit) => (
                <button
                  key={hit.key}
                  type="button"
                  role="option"
                  aria-selected={hit.index === current}
                  onMouseMove={() => setActive(hit.index)}
                  onClick={() => open(hit)}
                  className={cn(
                    "flex w-full items-baseline gap-2 px-4 py-1.5 text-left",
                    hit.index === current && "bg-muted",
                  )}
                >
                  <span className="truncate">{hit.label}</span>
                  {hit.detail && <span className="truncate text-[13px] text-muted-foreground">{hit.detail}</span>}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
