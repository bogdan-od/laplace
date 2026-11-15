import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatGuestTime, type PlayerMark } from "@/machine/player-marks";
import { cn } from "@/lib/utils";
import { MARK_STYLE } from "./mark-style";

export interface CommandListProps {
  marks: readonly PlayerMark[];
  /** Index into the commands of the one the position is on. */
  current: number;
  onPick: (mark: PlayerMark) => void;
  /** The user whose comments may be deleted from the list; none: nobody's. */
  commentOwner?: number;
  onDeleteComment?: (id: number) => void;
  className?: string | undefined;
}

/** The commands and the other marks as a list with a search box; a click moves the player to the moment. */
export function CommandList({ marks, current, onPick, commentOwner, onDeleteComment, className }: CommandListProps) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle === "" ? marks : marks.filter((mark) => mark.label.toLowerCase().includes(needle));

  useEffect(() => {
    document.querySelector('[data-testid="command-item"][data-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <aside data-testid="command-panel" className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-2", className)}>
      <Input
        data-testid="command-search"
        value={query}
        placeholder="Пошук серед команд (/)"
        aria-label="Пошук серед команд"
        onChange={(event) => setQuery(event.target.value)}
      />
      {shown.length === 0 ? (
        <p className="rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
          {marks.length === 0 ? "У записі немає команд" : "Нічого не знайдено"}
        </p>
      ) : (
        <ul data-testid="command-list" className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg border bg-card">
          {shown.map((mark) => (
            <li key={mark.id} className="flex items-center border-b last:border-b-0">
              <button
                type="button"
                data-testid="command-item"
                data-kind={mark.kind}
                data-current={mark.command !== null && mark.command === current}
                title={mark.label}
                className={cn(
                  "flex min-w-0 flex-1 items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted",
                  mark.command !== null && mark.command === current && "bg-primary/10 font-medium",
                )}
                onClick={(event) => {
                  event.currentTarget.blur();
                  onPick(mark);
                }}
              >
                <span aria-hidden className={cn("size-2 shrink-0 self-center rounded-full", MARK_STYLE[mark.kind].dot)} />
                <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{formatGuestTime(mark.time)}</span>
                <span className={cn("min-w-0 truncate", mark.kind === "command" || mark.kind === "teacher" ? "font-mono" : "")}>
                  {mark.label}
                </span>
              </button>
              {mark.comment !== undefined && mark.comment.author === commentOwner && onDeleteComment !== undefined && (
                <button
                  type="button"
                  data-testid="comment-delete"
                  aria-label="Видалити коментар"
                  title="Видалити коментар"
                  className="mr-2 shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onDeleteComment(mark.comment?.id ?? 0)}
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
