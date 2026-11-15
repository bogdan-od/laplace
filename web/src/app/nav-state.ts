import { useSyncExternalStore } from "react";

/*
 * Pages that list things open with the menu; pages where the teacher works with one assignment
 * or student open without it, because the table and the terminal need the width. The choice is
 * remembered separately for each kind.
 */
export type PageKind = "list" | "work";

const storageKey = (kind: PageKind) => `nav-open.${kind}`;
const listeners = new Set<() => void>();

function read(kind: PageKind): boolean {
  try {
    const saved = localStorage.getItem(storageKey(kind));
    return saved === null ? kind === "list" : saved === "1";
  } catch {
    return kind === "list";
  }
}

export function writeNavOpen(kind: PageKind, open: boolean): void {
  try {
    localStorage.setItem(storageKey(kind), open ? "1" : "0");
  } catch {
    // Storage is blocked: the menu keeps its default state.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function useNavOpen(kind: PageKind): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    subscribe,
    () => read(kind),
    () => kind === "list",
  );
  return [open, (value) => writeNavOpen(kind, value)];
}
