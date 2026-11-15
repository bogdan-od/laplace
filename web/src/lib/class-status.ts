import type { ClassSummary } from "@shared/api";
import { formatDate, plural } from "./format";

export interface ClassCounter {
  kind: "help" | "review";
  count: number;
  /** The full phrase for the tooltip and screen readers: "2 запити \"не працює\"". */
  label: string;
}

export interface ClassStatus {
  /** What needs the teacher first; empty when nothing does. */
  counters: ClassCounter[];
  /** Shown instead of the counters when there are none. */
  note: string;
}

/** Status under a class in the menu: short counters of what needs the teacher, or a quiet note. */
export function classStatus(c: ClassSummary): ClassStatus {
  const counters: ClassCounter[] = [];
  if (c.open_help > 0) {
    counters.push({ kind: "help", count: c.open_help, label: `${plural(c.open_help, "запит", "запити", "запитів")} "не працює"` });
  }
  if (c.to_review > 0) {
    counters.push({ kind: "review", count: c.to_review, label: `${plural(c.to_review, "здача", "здачі", "здач")} на перевірку` });
  }
  const note =
    c.next_due_at !== null ? `Найближчий строк ${formatDate(c.next_due_at)}` : plural(c.students, "студент", "студенти", "студентів");
  return { counters, note };
}
