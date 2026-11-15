// The attempt tree: branches as a tree by parent_id, with a label for the kind of each.

import { commands, type JournalEvent } from "@core/core/journal.mjs";
import type { Branch, BranchKind } from "@shared/api";

export interface TreeNode {
  branch: Branch;
  label: string;
  /** The branch is the current head of its machine. */
  head: boolean;
  depth: number;
  children: TreeNode[];
}

export interface TreeOptions {
  headIds: ReadonlySet<number>;
  /**
   * For a rollback branch: the number of the command it rolled back to (1 is the first command),
   * by branch id. Without it the label has no number: the branch alone does not know the commands.
   */
  commandNumbers?: ReadonlyMap<number, number>;
}

/** Where a branch is played back; `atMs` is the guest time the player opens at (`?t=`), without it the start. */
export function branchHref(branchId: number, atMs?: number): string {
  return atMs === undefined ? `/play/branch-${branchId}` : `/play/branch-${branchId}?t=${Math.round(atMs)}`;
}

export function branchLabel(kind: BranchKind, forkEvent: number, commandNumber?: number): string {
  switch (kind) {
    case "start":
      return "початок";
    case "rollback":
      if (forkEvent === 0 || commandNumber === 0) return "відкат до початку";
      return commandNumber === undefined ? "відкат" : `відкат до команди ${commandNumber}`;
    case "continue":
      return "продовження";
    case "reply":
      return "відповідь викладача";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function byCreation(a: Branch, b: Branch): number {
  return a.created_at - b.created_at || a.id - b.id;
}

/** Roots first, children in the order they were made. A branch whose parent is missing becomes a root. */
export function buildBranchTree(branches: readonly Branch[], options: TreeOptions): TreeNode[] {
  const ids = new Set(branches.map((branch) => branch.id));
  const childrenOf = new Map<number | null, Branch[]>();
  for (const branch of [...branches].sort(byCreation)) {
    const parent = branch.parent_id !== null && ids.has(branch.parent_id) ? branch.parent_id : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(branch);
    childrenOf.set(parent, list);
  }
  const build = (parent: number | null, depth: number): TreeNode[] =>
    (childrenOf.get(parent) ?? []).map((branch) => ({
      branch,
      label: branchLabel(branch.kind, branch.fork_event, options.commandNumbers?.get(branch.id)),
      head: options.headIds.has(branch.id),
      depth,
      children: build(branch.id, depth + 1),
    }));
  return build(null, 0);
}

/** The tree as a list in drawing order (parent, then its subtree). */
export function flattenTree(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

/**
 * Command numbers for rollback branches that lie on the path to the head. `events` is the head's own
 * journal: for a branch on that path, everything before its fork point is the same in the journal of its
 * parent, so the commands can be counted there. Branches off the path stay without a number.
 */
export function rollbackCommandNumbers(
  branches: readonly Branch[],
  headId: number,
  events: readonly JournalEvent[],
  startIndex: number,
): Map<number, number> {
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  const starts = commands(events)
    .filter((command) => command.by === "student" && command.port === 0 && command.start >= startIndex)
    .map((command) => command.start);
  const numbers = new Map<number, number>();
  for (let id: number | null = headId; id !== null; ) {
    const branch = byId.get(id);
    if (!branch) break;
    if (branch.kind === "rollback") {
      const before = starts.filter((start) => start < branch.fork_event).length;
      // 0 marks a rollback to where the student's work began ("До початку").
      numbers.set(branch.id, branch.fork_event <= startIndex ? 0 : before + 1);
    }
    id = branch.parent_id;
  }
  return numbers;
}
