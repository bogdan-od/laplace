import type { HelpRequest, ReviewItem } from "@shared/api";
import { formatWhen } from "@/lib/format";
import { agoText } from "@/pages/class/student-view";

export type ReviewFilter = "all" | ReviewItem["kind"];

export const REVIEW_FILTERS: readonly { value: ReviewFilter; label: string }[] = [
  { value: "all", label: "Усі" },
  { value: "submission", label: "Здачі" },
  { value: "help", label: "Не працює" },
];

export const REVIEW_KIND_LABEL: Record<ReviewItem["kind"], string> = { submission: "Здача", help: "Не працює" };

const MS_PER_DAY = 86_400_000;

export interface ReviewClass {
  id: number;
  name: string;
}

/** When the item appeared: the submission or the request. */
export function reviewAt(item: ReviewItem): number {
  return item.kind === "submission" ? item.submission.created_at : item.help.created_at;
}

export function reviewKey(item: ReviewItem): string {
  return item.kind === "submission" ? `submission-${item.submission.id}` : `help-${item.help.id}`;
}

export function reviewStudentName(item: ReviewItem): string {
  return item.kind === "submission" ? item.student.name : item.help.student.name;
}

function reviewId(item: ReviewItem): number {
  return item.kind === "submission" ? item.submission.id : item.help.id;
}

/** Newest first; ids and then the kind break ties so that the order never jumps between reloads. */
export function sortReview(items: readonly ReviewItem[]): ReviewItem[] {
  return [...items].sort(
    (a, b) => reviewAt(b) - reviewAt(a) || reviewId(b) - reviewId(a) || a.kind.localeCompare(b.kind),
  );
}

/** The classes that occur in the items, by name. */
export function reviewClasses(items: readonly ReviewItem[]): ReviewClass[] {
  const byId = new Map<number, ReviewClass>();
  for (const item of items) byId.set(item.class.id, item.class);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "uk") || a.id - b.id);
}

/** Items of the chosen kind and class (null: every class), newest first. */
export function filterReview(items: readonly ReviewItem[], filter: ReviewFilter, classId: number | null): ReviewItem[] {
  return sortReview(items.filter((item) => (filter === "all" || item.kind === filter) && (classId === null || item.class.id === classId)));
}

/** Within a day "12 хв тому", older: the date ("10 листопада, 14:05"); there is no "days ago" wording. */
export function reviewWhen(ms: number, now: number): string {
  return now - ms < MS_PER_DAY ? agoText(ms, now) : formatWhen(ms, now);
}

/** Where a row leads: a page of the student, or the player at the moment of the request (the time is read from the journal). */
export type ReviewTarget = { kind: "page"; href: string } | { kind: "moment"; help: HelpRequest };

export function reviewTarget(item: ReviewItem): ReviewTarget {
  if (item.kind === "help") return { kind: "moment", help: item.help };
  const { class: klass, assignment, student, submission } = item;
  return { kind: "page", href: `/classes/${klass.id}/assignments/${assignment.id}/students/${student.id}?submission=${submission.id}` };
}
