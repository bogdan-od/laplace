import { useMemo, useSyncExternalStore } from "react";

function subscribeTo(query: string) {
  return (listener: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", listener);
    return () => list.removeEventListener("change", listener);
  };
}

/** True while the window matches the media query; without `matchMedia` (a test renderer) it is `fallback`. */
export function useMediaQuery(query: string, fallback = true): boolean {
  const supported = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const subscribe = useMemo(() => (supported ? subscribeTo(query) : () => () => undefined), [query, supported]);
  return useSyncExternalStore(
    subscribe,
    () => (supported ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

/** The width of Tailwind's `lg` breakpoint: from here the menu sits beside the page, below it is a drawer. */
export const useIsDesktop = () => useMediaQuery("(min-width: 64rem)");
