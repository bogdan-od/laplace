import { describe, expect, it } from "vitest";
import type { JournalRef } from "@shared/api";
import { defaultTopology } from "./library-list";
import { lostJournalNodes, orphanChecks, parseTopologyText, topologyText } from "./topology-text";

describe("parseTopologyText", () => {
  it("accepts the text of a correct topology", () => {
    const draft = parseTopologyText(topologyText(defaultTopology()));
    expect(draft.problems).toEqual([]);
    expect(draft.topology).toEqual(defaultTopology());
  });
  it("reports a syntax error in one line", () => {
    const draft = parseTopologyText('{ "format": ');
    expect(draft.topology).toBeNull();
    expect(draft.problems).toHaveLength(1);
    expect(draft.problems[0]).toMatch(/^Помилка JSON: /);
  });
  it("lists the messages of validate_topology for valid JSON that is not a topology", () => {
    const draft = parseTopologyText(JSON.stringify({ ...defaultTopology(), machines: [] }));
    expect(draft.topology).toBeNull();
    expect(draft.problems.length).toBeGreaterThan(0);
    expect(draft.problems.every((problem) => !problem.startsWith("Помилка JSON"))).toBe(true);
    expect(parseTopologyText("42").problems.length).toBeGreaterThan(0);
  });
});

describe("lostJournalNodes", () => {
  const journals: JournalRef[] = [
    { node: "m1", role: "start", size: 1 },
    { node: "m2", role: "start", size: 1 },
    { node: "m2", role: "reference", size: 1 },
  ];
  it("names each machine with a journal that is not in the topology, once", () => {
    expect(lostJournalNodes(journals, defaultTopology())).toEqual(["m2"]);
  });
  it("is empty when every machine stays", () => {
    expect(lostJournalNodes(journals.slice(0, 1), defaultTopology())).toEqual([]);
  });
});

describe("orphanChecks", () => {
  it("returns the rows with a command whose machine is gone", () => {
    const rows = [
      { node: "m1", command: "ls" },
      { node: "m2", command: "ping x" },
      { node: "m3", command: "  " },
    ];
    expect(orphanChecks(rows, defaultTopology().machines)).toEqual([{ node: "m2", command: "ping x" }]);
  });
});
