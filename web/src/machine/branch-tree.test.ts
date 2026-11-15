import { describe, expect, it } from "vitest";
import type { JournalEvent } from "@core/core/journal.mjs";
import type { Branch, BranchKind } from "@shared/api";
import { branchLabel, buildBranchTree, flattenTree, rollbackCommandNumbers } from "./branch-tree";
import { rollbackOptions } from "./rollback-list";

function branch(id: number, kind: BranchKind, parent: number | null, fork: number, extra: Partial<Branch> = {}): Branch {
  return {
    id,
    node: "node",
    parent_id: parent,
    fork_event: fork,
    kind,
    author: { id: kind === "reply" ? 2 : 1, name: kind === "reply" ? "Викладач" : "Студент" },
    event_count: fork + 5,
    bytes: 100,
    created_at: 1000 + id,
    updated_at: 1000 + id,
    ...extra,
  };
}

function typed(text: string, from: number): JournalEvent[] {
  return [...text, "\r"].map((data, i) => ({ t: "serial", c: (from + i) * 10, w: 0, data }));
}

describe("buildBranchTree", () => {
  it("makes three levels start -> rollback -> reply with labels", () => {
    const branches = [
      branch(1, "start", null, 0),
      branch(2, "rollback", 1, 7),
      branch(3, "reply", 2, 9),
    ];
    const tree = buildBranchTree(branches, { headIds: new Set([2]), commandNumbers: new Map([[2, 3]]) });

    expect(tree).toHaveLength(1);
    const [root] = tree;
    expect(root?.label).toBe("початок");
    expect(root?.depth).toBe(0);
    const rollback = root?.children[0];
    expect(rollback?.label).toBe("відкат до команди 3");
    expect(rollback?.head).toBe(true);
    expect(rollback?.depth).toBe(1);
    const reply = rollback?.children[0];
    expect(reply?.label).toBe("відповідь викладача");
    expect(reply?.depth).toBe(2);
    expect(reply?.head).toBe(false);
    expect(flattenTree(tree).map((n) => n.branch.id)).toEqual([1, 2, 3]);
  });

  it("labels every kind; rollback to the start and without a known number", () => {
    expect(branchLabel("start", 0)).toBe("початок");
    expect(branchLabel("rollback", 0)).toBe("відкат до початку");
    expect(branchLabel("rollback", 4)).toBe("відкат");
    expect(branchLabel("rollback", 4, 2)).toBe("відкат до команди 2");
    expect(branchLabel("continue", 9)).toBe("продовження");
    expect(branchLabel("reply", 9)).toBe("відповідь викладача");
  });

  it("puts siblings in creation order and keeps an orphan as a root", () => {
    const branches = [
      branch(1, "start", null, 0),
      branch(5, "continue", 1, 6, { created_at: 3000 }),
      branch(3, "rollback", 1, 2, { created_at: 2000 }),
      branch(9, "rollback", 99, 2, { created_at: 4000 }),
    ];
    const tree = buildBranchTree(branches, { headIds: new Set() });
    expect(tree.map((n) => n.branch.id)).toEqual([1, 9]);
    expect(tree[0]?.children.map((n) => n.branch.id)).toEqual([3, 5]);
  });

  it("counts the command number of a rollback along the head path from the head journal", () => {
    // commands: "ls" starts at 0, "pwd" at 3, "id" at 7
    const events = [...typed("ls", 0), ...typed("pwd", 3), ...typed("id", 8)];
    const options = rollbackOptions({ header: {} as never, events }, 0);
    expect(options.map((o) => o.text)).toEqual([undefined, "ls", "pwd", "id"]);
    const pwd = options[2];
    expect(pwd?.number).toBe(2);

    const branches = [branch(1, "start", null, 0), branch(2, "rollback", 1, pwd?.index ?? -1), branch(3, "rollback", 2, 0)];
    const numbers = rollbackCommandNumbers(branches, 3, events, 0);
    expect(numbers.get(2)).toBe(2);
    expect(numbers.get(3)).toBe(0); // rollback to the start
  });
});
