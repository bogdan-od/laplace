import { describe, expect, it } from "vitest";
import type { LibraryItem } from "@shared/api";
import { saveFailureText, savePlan } from "./record-plan";

const topology: LibraryItem["topology"] = {
  format: "v86-topology/1",
  machines: [
    { id: "m1", profile: "buildroot" },
    { id: "m2", profile: "buildroot" },
  ],
  switches: [],
  links: [],
};

describe("savePlan", () => {
  it("covers every machine of the topology and replaces nothing when the role has no journals", () => {
    const plan = savePlan({ topology, journals: [{ node: "m1", role: "reference", size: 1 }] }, "start");
    expect(plan).toEqual({ nodes: ["m1", "m2"], replaced: [] });
  });
  it("lists the machines that already have a journal of the role", () => {
    const journals = [
      { node: "m2", role: "start" as const, size: 1 },
      { node: "m1", role: "reference" as const, size: 1 },
    ];
    expect(savePlan({ topology, journals }, "start").replaced).toEqual(["m2"]);
    expect(savePlan({ topology, journals }, "reference").replaced).toEqual(["m1"]);
  });
});

describe("saveFailureText", () => {
  it("names the machine and what is already saved", () => {
    expect(saveFailureText("m2", ["m1"], "Журнал завеликий")).toBe('Не вдалося зберегти журнал машини "m2": Журнал завеликий. Уже збережено: m1.');
    expect(saveFailureText("m1", [], "x")).toBe('Не вдалося зберегти журнал машини "m1": x.');
  });
});
