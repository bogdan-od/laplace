// Pure parts of the teacher's view of one attempt: the trees per machine, the help requests, the submissions.

import type { Attempt, Branch, HelpRequest, SubmissionSummary } from "@shared/api";
import { formatWhen } from "@/lib/format";
import { buildBranchTree, type TreeNode } from "@/machine/branch-tree";

export interface MachineTree {
  node: string;
  tree: TreeNode[];
}

/** One tree per machine: the machines of the topology first, then any other machine the branches name. */
export function attemptTrees(
  attempt: Attempt,
  machines: readonly string[],
  commandNumbers: ReadonlyMap<number, number>,
): MachineTree[] {
  const headIds = new Set(Object.values(attempt.heads));
  const nodes = [...new Set([...machines, ...attempt.branches.map((branch) => branch.node)])];
  return nodes.map((node) => ({
    node,
    tree: buildBranchTree(
      attempt.branches.filter((branch) => branch.node === node),
      { headIds, commandNumbers },
    ),
  }));
}

export interface RollbackTarget {
  node: string;
  headId: number;
  /** The rollback branches on the path from the root to the head. */
  rollbackIds: number[];
}

/** The machines whose head path contains a rollback: only for them the command numbers need the head's journal. */
export function rollbackTargets(attempt: Attempt): RollbackTarget[] {
  const byId = new Map<number, Branch>(attempt.branches.map((branch) => [branch.id, branch]));
  const targets: RollbackTarget[] = [];
  for (const [node, headId] of Object.entries(attempt.heads)) {
    const rollbackIds: number[] = [];
    for (let branch = byId.get(headId); branch; branch = branch.parent_id === null ? undefined : byId.get(branch.parent_id)) {
      if (branch.kind === "rollback") rollbackIds.push(branch.id);
    }
    if (rollbackIds.length > 0) targets.push({ node, headId, rollbackIds });
  }
  return targets;
}

export type HelpState = "open" | "replied" | "closed";

export const HELP_STATE_TEXT: Record<HelpState, string> = {
  open: "Відкрито",
  replied: "Є відповідь",
  closed: "Закрито",
};

export function helpState(help: HelpRequest): HelpState {
  if (help.resolved_at !== null) return "closed";
  return help.reply_branch_id === null ? "open" : "replied";
}

/** Newest first. */
export function sortHelp(help: readonly HelpRequest[]): HelpRequest[] {
  return [...help].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
}

/** Newest first. */
export function sortSubmissions(submissions: readonly SubmissionSummary[]): SubmissionSummary[] {
  return [...submissions].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
}

/** A machine without forks: its tree is one branch, so there is nothing to draw. */
export function isSingleBranch(tree: readonly TreeNode[]): boolean {
  return tree.length === 1 && tree[0]?.children.length === 0;
}

export interface BranchStamp {
  author: string;
  when: string;
}

/**
 * The author and time of the machines that have no forks, when there are several of them and all
 * the same (the student opens all machines at once): they are shown once above the trees.
 */
export function sharedStamp(trees: readonly MachineTree[], now: number = Date.now()): BranchStamp | null {
  const stamps = trees
    .filter(({ tree }) => isSingleBranch(tree))
    .map(({ tree }) => tree[0]!.branch)
    .map((branch) => ({ author: branch.author.name, when: formatWhen(branch.created_at, now) }));
  const [first] = stamps;
  if (stamps.length < 2 || first === undefined) return null;
  return stamps.every((stamp) => stamp.author === first.author && stamp.when === first.when) ? first : null;
}
