import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import type { MachineRuntime, RuntimeView } from "./machine-runtime";

/**
 * The guest assumes exactly this width: a narrower terminal wraps lines the guest believes are intact, a wider
 * one only adds an empty strip on the right. The box is as wide as these columns; rows follow the height.
 */
const GUEST_COLS = 80;
const MIN_ROWS = 10;
const FONT_SIZE = 15;
const MIN_FONT_SIZE = 6;
const FIT_ROUNDS = 6;
const SCROLLBACK = 5000;

export interface MachineTerminalProps {
  runtime: MachineRuntime;
  view: RuntimeView;
  className?: string;
  /** In a narrow place: the font shrinks until all 80 columns fit, instead of the terminal growing a scrollbar. */
  shrinkToFit?: boolean;
}

/**
 * The console of one machine: draws what the machine printed (also what it printed before the mount),
 * sends typing to the runtime, which drops it when the state does not accept input, and covers the
 * terminal with the text of the state. The guest cursor is hidden while the
 * student cannot type.
 */
export function MachineTerminal({ runtime, view, className, shrinkToFit = false }: MachineTerminalProps) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const terminal = new Terminal({
      cols: GUEST_COLS,
      rows: MIN_ROWS,
      convertEol: false,
      scrollback: SCROLLBACK,
      fontFamily: style.fontFamily,
      fontSize: FONT_SIZE,
      theme: { background: style.backgroundColor, foreground: style.color },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    term.current = terminal;

    const refit = () => {
      let size = fit.proposeDimensions();
      for (let round = 0; shrinkToFit && size && round < FIT_ROUNDS && size.cols < GUEST_COLS; round++) {
        const font = Math.max(MIN_FONT_SIZE, Math.floor(((terminal.options.fontSize ?? FONT_SIZE) * size.cols) / GUEST_COLS * 10) / 10);
        if (font === terminal.options.fontSize) break;
        terminal.options.fontSize = font;
        size = fit.proposeDimensions();
      }
      if (!size || !Number.isFinite(size.rows)) return;
      terminal.resize(GUEST_COLS, Math.max(MIN_ROWS, size.rows));
      element.dataset.font = String(terminal.options.fontSize);
    };
    refit();
    // The browser scrolls the terminal sideways to the typing caret and leaves it there; keep the view at the left
    // edge unless the cursor is out of sight, then bring it back.
    const followCursor = () => {
      const screen = element.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) return;
      const cell = screen.clientWidth / GUEST_COLS;
      const left = terminal.buffer.active.cursorX * cell;
      const right = left + cell;
      if (left < element.scrollLeft) element.scrollLeft = left < element.clientWidth ? 0 : left;
      else if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth;
    };
    const parsed = terminal.onWriteParsed(followCursor);
    const observer = new ResizeObserver(refit);
    observer.observe(element);

    for (const chunk of runtime.output.chunks()) terminal.write(chunk);
    const offOutput = runtime.subscribeOutput((event) => {
      if (event.kind === "reset") terminal.reset();
      else if (event.port === 0) terminal.write(event.bytes);
    });
    const input = terminal.onData((data) => void runtime.type(data));

    return () => {
      offOutput();
      input.dispose();
      parsed.dispose();
      observer.disconnect();
      terminal.dispose();
      term.current = null;
    };
  }, [runtime, shrinkToFit]);

  useEffect(() => {
    term.current?.write(view.cursorHidden ? "\x1b[?25l" : "\x1b[?25h");
  }, [view.cursorHidden]);

  return (
    <div
      className={cn(
        "relative max-w-full overflow-hidden rounded-lg bg-terminal p-2 text-terminal-foreground",
        shrinkToFit ? "w-full" : "w-fit",
        className,
      )}
    >
      <div
        ref={host}
        data-testid="terminal"
        data-state={view.state}
        data-node={view.node}
        className="h-full min-h-60 overflow-x-auto font-mono bg-terminal text-terminal-foreground"
      />
      {view.overlay !== null && (
        <div
          data-testid="terminal-overlay"
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-terminal/80 p-6 text-center font-sans text-sm"
        >
          <p>{view.overlay}</p>
          {view.state === "restoring" && (
            <div className="h-1.5 w-48 overflow-hidden rounded-full bg-terminal-foreground/20">
              <div className="h-full bg-terminal-foreground" style={{ width: `${view.percent}%` }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
