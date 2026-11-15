import { useRef } from "react";
import { formatGuestTime, type PlayerMark } from "@/machine/player-marks";
import { cn } from "@/lib/utils";
import { MarkBadge } from "./MarkBadge";
import { MARK_KINDS, MARK_STYLE, hasBadge } from "./mark-style";

const PERCENT = 100;

export interface TimelineProps {
  duration: number;
  position: number;
  marks: readonly PlayerMark[];
  seeking: boolean;
  onSeek: (ms: number) => void;
  /** The interval of a clip being cut: either end can still be unset. */
  range?: { from: number | null; to: number | null };
  /** The marks of a lesson being marked up: a note is a line (`to = from`), a segment "now on your own" is a band. */
  spans?: readonly TimelineSpan[];
}

export interface TimelineSpan {
  id: string;
  kind: "note" | "self";
  from: number;
  to: number;
  label: string;
}

/** The time of the guest: a click or a drag seeks, the marks show commands and what else happened. */
export function Timeline({ duration, position, marks, seeking, onSeek, range, spans = [] }: TimelineProps) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const percent = (ms: number) => (duration > 0 ? Math.min(PERCENT, (ms / duration) * PERCENT) : 0);
  const timeAt = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * duration;
  };

  return (
    <div data-testid="timeline-box" className="flex flex-col gap-1.5">
      <div
        ref={track}
        data-testid="timeline"
        role="slider"
        tabIndex={0}
        aria-label="Шкала часу"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        className="relative h-9 w-full cursor-pointer touch-none rounded-md border bg-muted select-none"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = true;
          onSeek(timeAt(event.clientX));
        }}
        onPointerMove={(event) => {
          if (dragging.current) onSeek(timeAt(event.clientX));
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        <div className="pointer-events-none absolute inset-y-0 left-0 rounded-l-md bg-primary/15" style={{ width: `${percent(position)}%` }} />
        {range !== undefined && (range.from !== null || range.to !== null) && (
          <div
            data-testid="clip-range"
            className="pointer-events-none absolute inset-y-0 rounded-md border-x-2 border-amber-500 bg-amber-500/25"
            style={{
              left: `${percent(range.from ?? range.to ?? 0)}%`,
              width: `${range.from !== null && range.to !== null ? Math.max(0, percent(range.to) - percent(range.from)) : 0}%`,
            }}
          />
        )}
        {spans.map((span) => (
          <span
            key={span.id}
            data-testid="lesson-span"
            data-kind={span.kind}
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-y-0",
              span.kind === "self" ? "border-x-2 border-teal-500 bg-teal-500/25" : "w-0.5 -translate-x-1/2 bg-teal-500",
            )}
            style={{
              left: `${percent(span.from)}%`,
              ...(span.kind === "self" ? { width: `${Math.max(0, percent(span.to) - percent(span.from))}%` } : {}),
            }}
          />
        ))}
        {marks.map((mark) => (
          <span
            key={mark.id}
            data-testid="timeline-mark"
            data-kind={mark.kind}
            // The text of a comment is read from the mark; the other marks only show, a click goes through to the track.
            {...(mark.kind === "comment" ? { title: mark.label } : { "aria-hidden": true })}
            className={cn(
              "absolute top-1/2 -translate-x-1/2 -translate-y-1/2",
              mark.kind === "comment" ? "cursor-help" : "pointer-events-none",
              !hasBadge(mark.kind) && cn("h-2.5 w-px", MARK_STYLE[mark.kind].dot),
            )}
            style={{ left: `${percent(mark.time)}%` }}
          >
            {hasBadge(mark.kind) && <MarkBadge kind={mark.kind} className="size-5" />}
          </span>
        ))}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: `${percent(position)}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        <span data-testid="timeline-time" className="tabular-nums">
          {formatGuestTime(position)} / {formatGuestTime(duration)}
        </span>
        {seeking && (
          <span data-testid="seeking" className="text-foreground">
            Перемотування…
          </span>
        )}
        <ul data-testid="legend" className="ml-auto flex flex-wrap gap-x-4 gap-y-1">
          {MARK_KINDS.map((kind) => (
            <li key={kind} className="flex items-center gap-1.5">
              {hasBadge(kind) ? (
                <MarkBadge kind={kind} className="size-4" />
              ) : (
                <span aria-hidden className={cn("h-2.5 w-px", MARK_STYLE[kind].dot)} />
              )}
              {MARK_STYLE[kind].label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
