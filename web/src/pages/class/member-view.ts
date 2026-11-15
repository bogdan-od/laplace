import type { Member } from "@shared/api";
import { formatWhen } from "@/lib/format";

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/** "щойно", "12 хв тому", then the date and time; "-" when the person never signed in. */
export function lastSeenText(ms: number | null, now: number): string {
  if (ms === null) return "-";
  const minutes = Math.max(0, Math.floor((now - ms) / MS_PER_MINUTE));
  if (minutes < 1) return "щойно";
  if (minutes < MINUTES_PER_HOUR) return `${minutes} хв тому`;
  return formatWhen(ms, now);
}

/** Students by number, assistants by name (they have no number). */
export function groupMembers(members: readonly Member[]): { students: Member[]; assistants: Member[] } {
  const students = members
    .filter((member) => member.role === "student")
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.user_id - b.user_id);
  const assistants = members.filter((member) => member.role === "assistant").sort((a, b) => a.name.localeCompare(b.name, "uk"));
  return { students, assistants };
}
