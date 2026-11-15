import type { Id } from '@shared/api';

/** The columns of a branch that decide which events belong to its full journal. */
export interface PathBranch {
  id: Id;
  fork_event: number;
  event_count: number;
  /** Total size of the branch's own chunks. */
  bytes: number;
}

/** Events [from, to) of the full journal that are stored in the chunks of one branch. */
export interface Segment {
  branch_id: Id;
  from: number;
  to: number;
}

/**
 * Which stored events make up the journal of the last branch of `path` (root first), cut to the
 * first `to` events (all of them by default).
 *
 * Every branch owns the events from its own `fork_event` on; those before it are the parent's.
 * A branch may fork below the `fork_event` of its parent (a rollback into the inherited part), so
 * the cut is propagated from the target to the root: an ancestor contributes only the events
 * below the lowest fork of everything after it on the path.
 */
export function journalSegments(
  path: readonly PathBranch[],
  to?: number,
): Segment[] {
  const target = path.at(-1);
  if (!target) return [];
  let cap = Math.min(to ?? target.event_count, target.event_count);
  const segments: Segment[] = [];
  for (let i = path.length - 1; i >= 0; i--) {
    const branch = path[i];
    const child = path[i + 1];
    if (!branch) continue;
    if (child) cap = Math.min(cap, child.fork_event);
    const end = Math.min(cap, branch.event_count);
    if (end > branch.fork_event) {
      segments.push({ branch_id: branch.id, from: branch.fork_event, to: end });
    }
  }
  return segments.reverse();
}

/** Stored size of the whole path, ancestors' chunks after the fork included. */
export const pathBytes = (path: readonly PathBranch[]): number =>
  path.reduce((sum, branch) => sum + branch.bytes, 0);
