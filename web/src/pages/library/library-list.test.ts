import { describe, expect, it } from "vitest";
import type { LibraryItemSummary } from "@shared/api";
import { assignedClasses, defaultTopology, filterItems } from "./library-list";

const link = (class_id: number, class_name: string) => ({ class_id, class_name, assignment_id: class_id * 10 });
const items: LibraryItemSummary[] = [
  { id: 1, kind: "task", title: "Налаштування IP", machines: 2, updated_at: 3, assigned: [link(1, "КН-21"), link(1, "КН-21"), link(2, "КН-22")] },
  { id: 2, kind: "lesson", title: "Що таке ip-адреса", machines: 1, updated_at: 2, assigned: [] },
  { id: 3, kind: "clip", title: "Кліп із ping", machines: 1, updated_at: 1, assigned: [] },
];

describe("filterItems", () => {
  it("keeps the order and everything for \"Усі\" with an empty query", () => {
    expect(filterItems(items, "all", "").map((item) => item.id)).toEqual([1, 2, 3]);
  });
  it("filters by kind", () => {
    expect(filterItems(items, "clip", "").map((item) => item.id)).toEqual([3]);
    expect(filterItems(items, "task", "").map((item) => item.id)).toEqual([1]);
  });
  it("searches the title, ignoring case and edge spaces", () => {
    expect(filterItems(items, "all", "  IP ").map((item) => item.id)).toEqual([1, 2]);
    expect(filterItems(items, "lesson", "ip").map((item) => item.id)).toEqual([2]);
    expect(filterItems(items, "all", "немає такого")).toEqual([]);
  });
});

describe("assignedClasses", () => {
  it("lists each class once", () => {
    expect(assignedClasses(items[0] as LibraryItemSummary)).toEqual(["КН-21", "КН-22"]);
    expect(assignedClasses(items[1] as LibraryItemSummary)).toEqual([]);
  });
});

describe("defaultTopology", () => {
  it("is one machine without links", () => {
    const topology = defaultTopology();
    expect(topology.machines).toHaveLength(1);
    expect(topology.links).toEqual([]);
  });
});
