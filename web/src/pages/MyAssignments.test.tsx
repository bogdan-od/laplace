import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { MyAssignment } from "@shared/api";
import { AssignmentTable } from "./MyAssignments";

function item(id: number, frozen: boolean): MyAssignment {
  return {
    id,
    class_id: 1,
    class_name: "КН-31",
    kind: "task",
    title: `Завдання ${id}`,
    due_at: null,
    max_grade: 10,
    created_at: id,
    counts: {},
    my_status: "work",
    my_grade: null,
    frozen,
  };
}

const render = (items: MyAssignment[]): string =>
  renderToString(
    <MemoryRouter>
      <AssignmentTable items={items} now={0} />
    </MemoryRouter>,
  );

describe("AssignmentTable frozen mark", () => {
  it("marks only the frozen assignment", () => {
    const html = render([item(1, true), item(2, false)]);
    expect(html.match(/data-testid="frozen-mark"/g)).toHaveLength(1);
    expect(html).toContain("Призупинено");
  });

  it("shows no mark when nothing is frozen", () => {
    expect(render([item(1, false)])).not.toContain("frozen-mark");
  });
});
