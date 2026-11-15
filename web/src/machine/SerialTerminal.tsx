import { useEffect, useRef, type ComponentProps } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import type { SerialListener } from "./serial-history";

/** Exactly the width the guest assumes, as in `MachineTerminal`; the height is fixed and the box scrolls inside. */
const GUEST_COLS = 80;
const ROWS = 24;
const FONT_SIZE = 15;
const SCROLLBACK = 5000;
/** RIS: resets the terminal, scrollback included. It goes through the write queue, so it cannot overtake earlier bytes. */
const RESET = "\x1bc";

export interface SerialTerminalProps extends Omit<ComponentProps<"div">, "children" | "onInput"> {
  /** What the port printed before the mount. */
  history: () => readonly Uint8Array[];
  /** Live bytes; `full` means the history was replaced and the screen starts over. Returns the unsubscribe. */
  subscribe: (listener: SerialListener) => () => void;
  /** Typing goes here; without it the terminal only shows. Keep it stable (useCallback) or the typing is re-attached. */
  onType?: (data: string) => void;
}

/** A terminal of one serial port of a remote machine, the teacher's view of a student's console. */
export function SerialTerminal({ history, subscribe, onType, className, ...rest }: SerialTerminalProps) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const terminal = new Terminal({
      cols: GUEST_COLS,
      rows: ROWS,
      convertEol: false,
      scrollback: SCROLLBACK,
      fontFamily: style.fontFamily,
      fontSize: FONT_SIZE,
      disableStdin: true,
      theme: { background: style.backgroundColor, foreground: style.color },
    });
    terminal.open(element);
    term.current = terminal;
    for (const chunk of history()) terminal.write(chunk);
    const off = subscribe((bytes, full) => {
      if (full) terminal.write(RESET);
      terminal.write(bytes);
    });
    return () => {
      off();
      terminal.dispose();
      term.current = null;
    };
  }, [history, subscribe]);

  useEffect(() => {
    const terminal = term.current;
    if (!terminal || !onType) return;
    terminal.options.disableStdin = false;
    const input = terminal.onData(onType);
    return () => {
      input.dispose();
      terminal.options.disableStdin = true;
    };
  }, [onType, history, subscribe]);

  return (
    <div
      className={cn("w-fit max-w-full overflow-x-auto rounded-lg bg-terminal p-2 text-terminal-foreground", className)}
      {...rest}
    >
      <div ref={host} className="font-mono bg-terminal text-terminal-foreground" />
    </div>
  );
}
