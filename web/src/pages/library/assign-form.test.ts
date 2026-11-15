import { describe, expect, it } from "vitest";
import type { Topology } from "@shared/api";
import { DEFAULT_MAX_GRADE, parseAssignForm, sharedLanAvailable, type AssignForm } from "./assign-form";
import { defaultTopology } from "./library-list";

const pair: Topology = {
  format: "v86-topology/1",
  machines: [{ id: "a", profile: "buildroot" }, { id: "b", profile: "buildroot" }],
  switches: [{ id: "s" }],
  links: [{ machine: "a", switch: "s", mode: "access", vlan: 1 }, { machine: "b", switch: "s", mode: "access", vlan: 1 }],
};
const form: AssignForm = { classId: 4, due: "", maxGrade: String(DEFAULT_MAX_GRADE), sharedLan: false };

describe("parseAssignForm", () => {
  it("an empty due date means no due date", () => {
    expect(parseAssignForm(form, defaultTopology())).toEqual({
      ok: true,
      body: { class_id: 4, due_at: null, max_grade: 12, shared_lan: false },
    });
  });
  it("reads the due date in the browser's time zone", () => {
    const parsed = parseAssignForm({ ...form, due: "2037-11-14T23:59" }, defaultTopology());
    expect(parsed.ok && parsed.body.due_at).toBe(new Date("2037-11-14T23:59").getTime());
  });
  it("refuses a bad date, a missing class and a bad maximum", () => {
    expect(parseAssignForm({ ...form, due: "not a date" }, defaultTopology()).ok).toBe(false);
    expect(parseAssignForm({ ...form, classId: null }, defaultTopology()).ok).toBe(false);
    for (const maxGrade of ["", "0", "101", "1.5", "abc"]) {
      expect(parseAssignForm({ ...form, maxGrade }, defaultTopology()).ok, maxGrade).toBe(false);
    }
    expect(parseAssignForm({ ...form, maxGrade: "100" }, defaultTopology()).ok).toBe(true);
  });
  it("the shared network goes only with one machine", () => {
    expect(sharedLanAvailable(defaultTopology())).toBe(true);
    expect(sharedLanAvailable(pair)).toBe(false);
    const one = parseAssignForm({ ...form, sharedLan: true }, defaultTopology());
    expect(one.ok && one.body.shared_lan).toBe(true);
    const two = parseAssignForm({ ...form, sharedLan: true }, pair);
    expect(two.ok && two.body.shared_lan).toBe(false);
  });
});
