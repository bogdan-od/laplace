import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { read_journal } from "@core/core/journal.mjs";
import type { Assignment, Attempt } from "@shared/api";
import { api } from "@/lib/api";
import { rollbackCommandNumbers } from "@/machine/branch-tree";
import { rollbackTargets, type RollbackTarget } from "./attempt-view";

async function numbersOf(assignment: Assignment, attempt: Attempt, target: RollbackTarget): Promise<[number, number][]> {
  const journal = await api("GET /api/branches/:id/journal", { params: { id: target.headId } });
  // Every branch begins with the start journal of the machine, so the student's own work starts after it.
  const hasStart = assignment.journals.some((ref) => ref.node === target.node && ref.role === "start");
  const startIndex = hasStart
    ? read_journal(await api("GET /api/assignments/:id/journals/:node", { params: { id: assignment.id, node: target.node }, query: { role: "start" } })).events.length
    : 0;
  return [...rollbackCommandNumbers(attempt.branches, target.headId, journal.events, startIndex)];
}

/**
 * "відкат до команди N" for the rollback branches on the head paths. The head's journal is read only for a machine that has
 * a rollback on its path, and again only when that set of rollbacks changes: later commands do not renumber earlier ones.
 */
export function useCommandNumbers(assignment: Assignment, attempt: Attempt | undefined): ReadonlyMap<number, number> {
  const targets = useMemo(() => (attempt ? rollbackTargets(attempt) : []), [attempt]);
  return useQueries({
    queries: targets.map((target) => ({
      queryKey: ["command-numbers", assignment.id, target.headId, target.rollbackIds.join(",")],
      queryFn: () => (attempt ? numbersOf(assignment, attempt, target) : Promise.resolve([])),
      staleTime: Infinity,
    })),
    combine: (results) => new Map(results.flatMap((result) => result.data ?? [])),
  });
}
