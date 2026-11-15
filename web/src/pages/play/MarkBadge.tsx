import type { MarkKind } from "@/machine/player-marks";
import { cn } from "@/lib/utils";
import { MARK_STYLE } from "./mark-style";

/*
 * Circle and icon are one SVG on purpose: as two elements the browser snaps the icon to whole pixels
 * but draws the circle at the fractional position the timeline gives it, and the mark ends up off-centre.
 */
export function MarkBadge({ kind, className }: { kind: MarkKind; className?: string }) {
  const badge = MARK_STYLE[kind].badge;
  if (!badge) return null;
  const { fill, Icon } = badge;
  return (
    <svg viewBox="0 0 24 24" className={cn("block", className)} aria-hidden>
      <circle cx={12} cy={12} r={12} className="fill-card" />
      <circle cx={12} cy={12} r={10} className={fill} />
      <Icon x={6} y={6} width={12} height={12} color="white" strokeWidth={2.75} />
    </svg>
  );
}
