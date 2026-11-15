import { useState } from "react";
import { Scissors } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeError } from "@/lib/api";
import { clipBody, clipProblem, defaultClipTitle, type ClipRange } from "@/machine/clip";
import { formatGuestTime } from "@/machine/player-marks";
import type { PlayerSession, PlayerView } from "@/machine/player-session";

export interface ClipBarProps {
  session: PlayerSession | null;
  view: PlayerView;
  range: ClipRange;
  onRange: (range: ClipRange) => void;
  onClose: () => void;
}

/** "Вирізати кліп": the ends are the moments the player stands at; the interval is drawn on the timeline above. */
export function ClipBar({ session, view, range, onRange, onClose }: ClipBarProps) {
  const navigate = useNavigate();
  const [typed, setTyped] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const source = view.clip;
  const problem = clipProblem(range);
  const title = typed ?? defaultClipTitle(view.title, source?.student ?? "", range);
  const canSave = session !== null && source !== null && problem === null && title.trim() !== "" && !saving && !view.seeking;

  const save = async () => {
    if (!session || !source || problem !== null) return;
    setSaving(true);
    try {
      const item = await session.saveClip(clipBody(source, range, title));
      toast.success("Кліп збережено", { action: { label: "Відкрити в бібліотеці", onClick: () => void navigate(`/library/${item.id}`) } });
      onClose();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      data-testid="clip-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Scissors className="size-4 text-muted-foreground" />
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="clip-start"
        disabled={view.seeking}
        onClick={() => onRange({ ...range, startMs: view.position })}
      >
        Початок тут
      </Button>
      <span data-testid="clip-start-time" className="w-12 text-sm tabular-nums">
        {range.startMs === null ? "-" : formatGuestTime(range.startMs)}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="clip-end"
        disabled={view.seeking}
        onClick={() => onRange({ ...range, endMs: view.position, endEvent: view.eventCount })}
      >
        Кінець тут
      </Button>
      <span data-testid="clip-end-time" className="w-12 text-sm tabular-nums">
        {range.endMs === null ? "-" : formatGuestTime(range.endMs)}
      </span>
      <Input
        data-testid="clip-title"
        aria-label="Назва кліпу"
        placeholder="Назва"
        className="h-8 min-w-60 flex-1"
        value={title}
        onChange={(event) => setTyped(event.target.value)}
      />
      {problem !== null && range.startMs !== null && range.endMs !== null && (
        <span data-testid="clip-problem" className="text-sm text-status-stuck">
          {problem}
        </span>
      )}
      <Button type="submit" size="sm" data-testid="clip-save" disabled={!canSave}>
        Зберегти кліп
      </Button>
      <Button type="button" size="sm" variant="ghost" data-testid="clip-cancel" onClick={onClose}>
        Скасувати
      </Button>
    </form>
  );
}
