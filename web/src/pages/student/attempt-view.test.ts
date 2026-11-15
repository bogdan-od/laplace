import { describe, expect, it } from "vitest";
import type { Attempt, Branch, BranchKind, HelpRequest } from "@shared/api";
import { flattenTree } from "@/machine/branch-tree";
import { attemptTrees, helpState, isSingleBranch, rollbackTargets, sharedStamp, sortHelp, sortSubmissions } from "./attempt-view";

function branch(id: number, kind: BranchKind, parent: number | null, fork: number, node = "m1"): Branch {
  return {
    id,
    node,
    parent_id: parent,
    fork_event: fork,
    kind,
    author: { id: kind === "reply" ? 2 : 1, name: kind === "reply" ? "Викладач" : "Студент" },
    event_count: fork + 5,
    bytes: 100,
    created_at: 1000 + id,
    updated_at: 1000 + id,
  };
}

function attempt(branches: Branch[], heads: Record<string, number>): Attempt {
  return {
    id: 1,
    assignment_id: 1,
    user: { id: 1, name: "Студент" },
    variant: 0,
    is_preview: false,
    created_at: 0,
    completed_at: null,
    heads,
    branches,
    help: [],
    submissions: [],
    hints_used: [],
  };
}

function help(id: number, patch: Partial<HelpRequest> = {}): HelpRequest {
  return {
    id,
    attempt_id: 1,
    assignment_id: 1,
    class_id: 1,
    student: { id: 1, name: "Студент" },
    node: "m1",
    branch_id: 1,
    event_count: 0,
    text: "?",
    created_at: id,
    resolved_at: null,
    reply_branch_id: null,
    ...patch,
  };
}

describe("attemptTrees", () => {
  const branches = [branch(1, "start", null, 0), branch(2, "rollback", 1, 4), branch(3, "continue", 2, 9), branch(4, "reply", 1, 4)];

  it("labels every kind of branch and marks the head", () => {
    const [group] = attemptTrees(attempt(branches, { m1: 3 }), ["m1"], new Map([[2, 2]]));
    const rows = flattenTree(group?.tree ?? []).map((row) => [row.label, row.head]);
    expect(rows).toEqual([
      ["початок", false],
      ["відкат до команди 2", false],
      ["продовження", true],
      ["відповідь викладача", false],
    ]);
  });

  it("makes a tree per machine, the topology's machines first", () => {
    const groups = attemptTrees(attempt([branch(1, "start", null, 0, "pc2")], { pc2: 1 }), ["pc1", "pc2"], new Map());
    expect(groups.map((group) => [group.node, flattenTree(group.tree).length])).toEqual([
      ["pc1", 0],
      ["pc2", 1],
    ]);
  });
});

describe("rollbackTargets", () => {
  it("names the machines with a rollback on the way to the head, and only those", () => {
    const branches = [branch(1, "start", null, 0), branch(2, "rollback", 1, 4), branch(3, "start", null, 0, "pc2")];
    expect(rollbackTargets(attempt(branches, { m1: 2, pc2: 3 }))).toEqual([{ node: "m1", headId: 2, rollbackIds: [2] }]);
    expect(rollbackTargets(attempt(branches, { m1: 1, pc2: 3 }))).toEqual([]);
  });
});

describe("help and submissions", () => {
  it("tells open, replied and closed requests apart", () => {
    expect(helpState(help(1))).toBe("open");
    expect(helpState(help(2, { reply_branch_id: 5 }))).toBe("replied");
    expect(helpState(help(3, { resolved_at: 9, reply_branch_id: 5 }))).toBe("closed");
  });

  it("lists the newest first", () => {
    expect(sortHelp([help(1), help(3), help(2)]).map((item) => item.id)).toEqual([3, 2, 1]);
    const submission = (id: number, created_at: number) => ({ id, attempt_id: 1, created_at, verify_status: "ok" as const, grade: null, checks: null });
    expect(sortSubmissions([submission(1, 10), submission(2, 30), submission(3, 20)]).map((item) => item.id)).toEqual([2, 3, 1]);
  });
});

describe("machines without forks", () => {
  const NOW = 5000;
  const start = (id: number, node: string, name = "Студент", created = 1000 + id) => ({
    ...branch(id, "start", null, 0, node),
    author: { id: 1, name },
    created_at: created,
  });

  it("a tree of one branch is a single branch, a fork is not", () => {
    const [flat, forked] = attemptTrees(
      attempt([start(1, "m1"), start(2, "m2"), branch(3, "rollback", 2, 4, "m2")], { m1: 1, m2: 3 }),
      ["m1", "m2"],
      new Map(),
    );
    expect(isSingleBranch(flat?.tree ?? [])).toBe(true);
    expect(isSingleBranch(forked?.tree ?? [])).toBe(false);
    expect(isSingleBranch([])).toBe(false);
  });

  it("the same author and minute on several flat machines is shown once", () => {
    const trees = attemptTrees(attempt([start(1, "m1"), start(2, "m2"), start(3, "m3")], {}), ["m1", "m2", "m3"], new Map());
    expect(sharedStamp(trees, NOW)).toEqual({ author: "Студент", when: expect.any(String) });
  });

  it("different authors or times, or a single flat machine, are not hoisted", () => {
    const names = attemptTrees(attempt([start(1, "m1"), start(2, "m2", "Інший")], {}), ["m1", "m2"], new Map());
    expect(sharedStamp(names, NOW)).toBeNull();
    const times = attemptTrees(attempt([start(1, "m1"), start(2, "m2", "Студент", 1000 + 3_600_000)], {}), ["m1", "m2"], new Map());
    expect(sharedStamp(times, NOW)).toBeNull();
    const one = attemptTrees(attempt([start(1, "m1")], {}), ["m1"], new Map());
    expect(sharedStamp(one, NOW)).toBeNull();
  });
});
