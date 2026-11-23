import { X } from "lucide-react";
import type { LessonMark } from "@core/core/journal.mjs";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { formatGuestTime } from "@/machine/player-marks";
import { CONTROL_CLASS } from "./controls";
import { placeOf, sortedMarks, startOf } from "./lesson-markup";

export interface MarkupActions {
  onText: (text: string) => void;
  onNote: () => void;
  onStart: () => void;
  onEnd: () => void;
  onRemove: (mark: LessonMark) => void;
  /** Moves the player to guest time `ms`. */
  onGo: (ms: number) => void;
  onSave: () => void;
}

export interface MarkupPanelProps {
  items: readonly LessonMark[];
  times: ArrayLike<number>;
  text: string;
  /** Event index where an unfinished segment began. */
  openFrom: number | null;
  error: string;
  /** The player may be asked for a moment. */
  ready: boolean;
  dirty: boolean;
  saving: boolean;
  actions: MarkupActions;
}

function placeText(mark: LessonMark, times: ArrayLike<number>): string {
  const from = formatGuestTime(placeOf(times, startOf(mark)));
  return mark.t === "self" ? `${from}-${formatGuestTime(placeOf(times, mark.to))}` : from;
}

/** To the right of the command list: the text field, the three buttons, the marks in order, the save button. */
export function MarkupPanel({ items, times, text, openFrom, error, ready, dirty, saving, actions }: MarkupPanelProps) {
  const marks = sortedMarks(items);
  return (
    <aside data-testid="markup-panel" className="flex min-h-0 w-full shrink-0 flex-col gap-2 lg:w-80">
      <h2 className="text-base font-semibold">Розмітка уроку</h2>
      <textarea
        className={`${CONTROL_CLASS} min-h-16`}
        aria-label="Текст пояснення або завдання"
        placeholder="Текст пояснення або завдання"
        data-testid="markup-text"
        value={text}
        onChange={(event) => actions.onText(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" data-testid="markup-note" disabled={!ready} onClick={actions.onNote}>
          Пояснення тут
        </Button>
        <Button size="sm" variant="outline" data-testid="markup-from" disabled={!ready} onClick={actions.onStart}>
          Сам: початок
        </Button>
        <Button size="sm" variant="outline" data-testid="markup-to" disabled={!ready} onClick={actions.onEnd}>
          Сам: кінець
        </Button>
      </div>
      {openFrom !== null && (
        <p data-testid="markup-pending" className="text-[13px] text-muted-foreground">
          Початок відрізка: подія {openFrom}
        </p>
      )}
      {error !== "" && (
        <p role="alert" data-testid="markup-error" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
      {marks.length === 0 ? (
        <p className="rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground" data-testid="markup-empty">
          Міток ще немає
        </p>
      ) : (
        <ul data-testid="markup-list" className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg border bg-card">
          {marks.map((mark, i) => (
            <li key={`${i}:${mark.t}:${startOf(mark)}`} className="flex items-center border-b last:border-b-0">
              <button
                type="button"
                data-testid="markup-item"
                data-kind={mark.t}
                title={mark.text}
                className="flex min-w-0 flex-1 items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => actions.onGo(placeOf(times, startOf(mark)))}
              >
                <span aria-hidden className="size-2 shrink-0 self-center rounded-full bg-teal-500" />
                <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{placeText(mark, times)}</span>
                <span className="shrink-0 text-[12px] text-muted-foreground">{mark.t === "note" ? "пояснення" : "сам"}</span>
                <span className="min-w-0 truncate">{mark.text}</span>
              </button>
              <button
                type="button"
                data-testid="markup-delete"
                aria-label="Видалити мітку"
                title="Видалити мітку"
                className="mr-2 shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => actions.onRemove(mark)}
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <PendingButton pending={saving} size="sm" disabled={!dirty} data-testid="markup-save" onClick={actions.onSave}>
          Зберегти урок
        </PendingButton>
        {dirty && (
          <span className="text-[13px] text-muted-foreground" data-testid="markup-unsaved">
            Є незбережені зміни
          </span>
        )}
      </div>
    </aside>
  );
}
