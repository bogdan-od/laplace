import { describe, expect, it } from "vitest";
import type { LibraryItem } from "@shared/api";
import { MAX_CHECKS, MAX_HINTS } from "@shared/limits";
import { defaultTopology } from "./library-list";
import { formOf, formProblem, isDirty, moveRow, patchBody, type ItemForm } from "./item-form";
import { topologyText } from "./topology-text";

const item: LibraryItem = {
  id: 1, kind: "task", title: "T", brief: "Умова", topology: defaultTopology(),
  checks: [{ node: "m1", title: "Ping", command: "ping -c1 10.0.0.1" }],
  hints: [{ text: "Перша", penalty: 1 }, { text: "Друга", penalty: 2 }],
  journals: [], clip_from_ms: null, embed_token: null, created_at: 1, updated_at: 1,
};

describe("patchBody", () => {
  it("round-trips an item unchanged", () => {
    expect(patchBody(formOf(item), item)).toEqual({ brief: "Умова", hints: item.hints, checks: item.checks });
    expect(isDirty(formOf(item), item)).toBe(false);
  });
  it("keeps the order of hints and drops empty ones", () => {
    const form: ItemForm = {
      brief: "",
      topology: topologyText(item.topology),
      hints: [{ text: " B ", penalty: "3" }, { text: "   ", penalty: "5" }, { text: "A", penalty: "" }],
      checks: [],
    };
    expect(patchBody(form, item).hints).toEqual([{ text: "B", penalty: 3 }, { text: "A", penalty: 0 }]);
  });
  it("drops checks without a command and names the rest by the command when the title is empty", () => {
    const form: ItemForm = {
      brief: "",
      topology: topologyText(item.topology),
      hints: [],
      checks: [{ node: "m1", title: "", command: " ls " }, { node: "m1", title: "Пусто", command: "  " }, { node: "m1", title: "Ping", command: "ping x" }],
    };
    expect(patchBody(form, item).checks).toEqual([{ node: "m1", title: "ls", command: "ls" }, { node: "m1", title: "Ping", command: "ping x" }]);
  });
});

describe("isDirty", () => {
  it("ignores an empty row that was added but not filled", () => {
    const form = formOf(item);
    expect(isDirty({ ...form, hints: [...form.hints, { text: "", penalty: "0" }] }, item)).toBe(false);
  });
  it("sees a change of the brief, the hint order and a check", () => {
    const form = formOf(item);
    expect(isDirty({ ...form, brief: "Нова" }, item)).toBe(true);
    expect(isDirty({ ...form, hints: moveRow(form.hints, 0, 1) }, item)).toBe(true);
    expect(isDirty({ ...form, checks: [{ node: "m1", title: "Ping", command: "ping -c2 10.0.0.1" }] }, item)).toBe(true);
  });
});

describe("formProblem", () => {
  it("accepts a normal form", () => {
    expect(formProblem(formOf(item), item)).toBeNull();
  });
  it("refuses a bad penalty with the number of the hint", () => {
    const form = formOf(item);
    expect(formProblem({ ...form, hints: [{ text: "x", penalty: "101" }] }, item)).toContain("Підказка 1");
    expect(formProblem({ ...form, hints: [{ text: "x", penalty: "1.5" }] }, item)).not.toBeNull();
    expect(formProblem({ ...form, hints: [{ text: "x", penalty: "abc" }] }, item)).not.toBeNull();
    expect(formProblem({ ...form, hints: [{ text: "x", penalty: "-1" }] }, item)).not.toBeNull();
  });
  it("refuses too many hints and checks", () => {
    const form = formOf(item);
    const hints = Array.from({ length: MAX_HINTS + 1 }, () => ({ text: "x", penalty: "0" }));
    const checks = Array.from({ length: MAX_CHECKS + 1 }, () => ({ node: "m1", title: "t", command: "c" }));
    expect(formProblem({ ...form, hints }, item)).toContain(String(MAX_HINTS));
    expect(formProblem({ ...form, checks }, item)).toContain(String(MAX_CHECKS));
  });
});

const TWO_MACHINES = {
  ...defaultTopology(),
  machines: [
    { id: "m1", profile: "buildroot" as const },
    { id: "m2", profile: "buildroot" as const },
  ],
  switches: [{ id: "sw1" }],
  links: [
    { machine: "m1", switch: "sw1", mode: "access" as const, vlan: 1 },
    { machine: "m2", switch: "sw1", mode: "access" as const, vlan: 1 },
  ],
};

describe("topology in the form", () => {
  it("is not in the body while it equals the saved one, even when it is written differently", () => {
    const form = formOf(item);
    expect(patchBody(form, item)).not.toHaveProperty("topology");
    expect(patchBody({ ...form, topology: JSON.stringify(item.topology) }, item)).not.toHaveProperty("topology");
    expect(isDirty({ ...form, topology: JSON.stringify(item.topology) }, item)).toBe(false);
  });
  it("is in the body when it is valid and changed, and makes the form dirty", () => {
    const form = { ...formOf(item), topology: topologyText(TWO_MACHINES) };
    expect(patchBody(form, item).topology).toEqual(TWO_MACHINES);
    expect(isDirty(form, item)).toBe(true);
    expect(formProblem(form, item)).toBeNull();
  });
  it("blocks saving on a JSON error and on messages of validate_topology", () => {
    const form = formOf(item);
    const broken = { ...form, topology: "{ nope" };
    expect(formProblem(broken, item)).toContain("Помилка JSON");
    expect(isDirty(broken, item)).toBe(true);
    expect(patchBody(broken, item)).not.toHaveProperty("topology");
    expect(formProblem({ ...form, topology: JSON.stringify({ ...item.topology, machines: [] }) }, item)).toContain("Топологія:");
  });
  it("blocks saving while a check points to a machine that left the topology", () => {
    const form = { ...formOf(item), topology: topologyText(TWO_MACHINES) };
    const onSecond = { ...form, checks: [{ node: "m2", title: "Ping", command: "ping x" }] };
    expect(formProblem(onSecond, item)).toBeNull();
    const back = { ...onSecond, topology: topologyText(item.topology) };
    expect(formProblem(back, item)).toBe('Перевірка "Ping": машини "m2" немає в топології');
    expect(formProblem({ ...back, checks: [{ node: "m2", title: "", command: "  " }] }, item)).toBeNull();
  });
});

describe("moveRow", () => {
  it("moves a row and leaves the input alone", () => {
    const rows = ["a", "b", "c"];
    expect(moveRow(rows, 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveRow(rows, 0, 1)).toEqual(["b", "a", "c"]);
    expect(rows).toEqual(["a", "b", "c"]);
  });
  it("does nothing at the edges", () => {
    expect(moveRow(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveRow(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});
