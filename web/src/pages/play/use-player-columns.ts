import { useLayoutEffect, useState } from "react";

const COLUMN_GAP_PX = 16;
/** The narrowest command list beside the terminal; with a side panel next to it the list needs room for a typical command. */
const LIST_MIN_REM = 15;
const LIST_WITH_SIDE_REM = 21;
/** The width of the side panel (`w-80`). */
const SIDE_REM = 20;

export interface PlayerColumns {
  /** The command list fits to the right of the terminal without getting narrower than its minimum. */
  listBeside: boolean;
  /** The side panel fits to the right of the list as well. */
  sideBeside: boolean;
}

/**
 * Which columns fit next to the terminal. The terminal is 80 columns wide whatever the window, so CSS cannot
 * tell how much is left for the others; the box is measured instead. `terminal` is the element whose first
 * child is the terminal box (the box keeps its width when the column below it is stretched).
 */
export function usePlayerColumns(row: HTMLElement | null, terminal: HTMLElement | null): PlayerColumns {
  const [columns, setColumns] = useState<PlayerColumns>({ listBeside: true, sideBeside: true });
  useLayoutEffect(() => {
    const box = terminal?.firstElementChild;
    if (!row || !(box instanceof HTMLElement)) return;
    const measure = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const room = row.clientWidth - box.offsetWidth - COLUMN_GAP_PX;
      const listBeside = room >= LIST_MIN_REM * rem;
      const sideBeside = room >= (LIST_WITH_SIDE_REM + SIDE_REM) * rem + COLUMN_GAP_PX;
      setColumns((previous) => (previous.listBeside === listBeside && previous.sideBeside === sideBeside ? previous : { listBeside, sideBeside }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(box);
    return () => observer.disconnect();
  }, [row, terminal]);
  return columns;
}
