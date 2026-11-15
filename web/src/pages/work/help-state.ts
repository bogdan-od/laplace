import type { Attempt, HelpRequest } from "@shared/api";

export interface HelpState {
  /** A request the teacher has not answered or closed yet. */
  open: boolean;
  /** The machines that have such a request. */
  openNodes: ReadonlySet<string>;
  /** An answer from the teacher that the student has not gone on from yet. */
  reply: HelpRequest | null;
}

/** The student went on from a reply when a `continue` branch hangs off it. */
export function helpState(attempt: Pick<Attempt, "help" | "branches"> | null): HelpState {
  if (!attempt) return { open: false, openNodes: new Set(), reply: null };
  const continued = new Set(attempt.branches.filter((branch) => branch.kind === "continue").map((branch) => branch.parent_id));
  const replies = attempt.help
    .filter((help) => help.reply_branch_id !== null && !continued.has(help.reply_branch_id))
    .sort((a, b) => b.created_at - a.created_at);
  const openNodes = new Set(attempt.help.filter((help) => help.resolved_at === null).map((help) => help.node));
  return { open: openNodes.size > 0, openNodes, reply: replies[0] ?? null };
}
