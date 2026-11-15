import { ClipboardPaste, CircleAlert, Keyboard, MessageSquare, RotateCcw, type LucideIcon } from "lucide-react";
import type { MarkKind } from "@/machine/player-marks";

export interface MarkStyle {
  label: string;
  /** Background of the small dot in the list and of the tick on the timeline. */
  dot: string;
  /** A rare event is drawn as a circle with this icon on the timeline; a command is only a tick. */
  badge?: { fill: string; Icon: LucideIcon };
}

/** One colour and one name per kind of mark: the timeline, the list and the legend all read it. */
export const MARK_STYLE: Record<MarkKind, MarkStyle> = {
  command: { label: "Команда", dot: "bg-primary" },
  help: { label: "Не працює", dot: "bg-status-stuck", badge: { fill: "fill-status-stuck", Icon: CircleAlert } },
  teacher: { label: "Ввід викладача", dot: "bg-status-work", badge: { fill: "fill-status-work", Icon: Keyboard } },
  paste: { label: "Вставка з буфера", dot: "bg-violet-500", badge: { fill: "fill-violet-500", Icon: ClipboardPaste } },
  comment: { label: "Коментар викладача", dot: "bg-sky-600", badge: { fill: "fill-sky-600", Icon: MessageSquare } },
  rollback: { label: "Відкат", dot: "bg-slate-600", badge: { fill: "fill-slate-600", Icon: RotateCcw } },
};

export const MARK_KINDS = Object.keys(MARK_STYLE) as MarkKind[];

/** Kinds drawn as a circle with an icon; the rest (commands) are ticks. */
export function hasBadge(kind: MarkKind): boolean {
  return MARK_STYLE[kind].badge !== undefined;
}
