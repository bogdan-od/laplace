import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Beside the terminal the right column needs at least this much (px); less, and it goes below the terminal. */
const MIN_ASIDE_PX = 320;
const COLUMN_GAP_PX = 16;

/** True while the column fits to the right of the terminal. Measured, because the terminal is 80 columns wide whatever the font. */
export function useAsideBeside(): { beside: boolean; container: RefObject<HTMLDivElement | null>; terminal: RefObject<HTMLDivElement | null> } {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<HTMLDivElement>(null);
  const [beside, setBeside] = useState(true);
  useLayoutEffect(() => {
    const outer = container.current;
    const inner = terminal.current;
    if (!outer || !inner) return;
    const measure = () => setBeside(outer.clientWidth - inner.offsetWidth - COLUMN_GAP_PX >= MIN_ASIDE_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  return { beside, container, terminal };
}
