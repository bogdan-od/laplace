import type { ItemKind, LibraryItemSummary, Topology } from "@shared/api";

export type KindFilter = "all" | ItemKind;

export const KIND_FILTERS: readonly { value: KindFilter; label: string }[] = [
  { value: "all", label: "Усі" },
  { value: "task", label: "Завдання" },
  { value: "lesson", label: "Уроки" },
  { value: "clip", label: "Кліпи" },
];

export const KIND_LABEL: Record<ItemKind, string> = { task: "Завдання", lesson: "Урок", clip: "Кліп" };

/** A new task starts as one buildroot machine. */
export function defaultTopology(): Topology {
  return { format: "v86-topology/1", machines: [{ id: "m1", title: "Buildroot", profile: "buildroot" }], switches: [], links: [] };
}

/** Items of the chosen kind whose title contains the query (case-insensitive, edges trimmed). */
export function filterItems(items: readonly LibraryItemSummary[], kind: KindFilter, query: string): LibraryItemSummary[] {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => (kind === "all" || item.kind === kind) && item.title.toLowerCase().includes(needle));
}

/** Names of the classes the item is assigned to, each once, in the order the server gives them. */
export function assignedClasses(item: LibraryItemSummary): string[] {
  return [...new Set(item.assigned.map((entry) => entry.class_name))];
}
