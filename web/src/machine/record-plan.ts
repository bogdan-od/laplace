import type { JournalRole, LibraryItem } from "@shared/api";

export interface SavePlan {
  /** Every machine of the topology gets a journal of the role. */
  nodes: string[];
  /** The machines that already have a journal of the role: saving replaces it. */
  replaced: string[];
}

export function savePlan(item: Pick<LibraryItem, "topology" | "journals">, role: JournalRole): SavePlan {
  const nodes = item.topology.machines.map((machine) => machine.id);
  const replaced = nodes.filter((node) => item.journals.some((journal) => journal.node === node && journal.role === role));
  return { nodes, replaced };
}

/** A PUT failed in the middle: what was already saved stays, and the text says which machines those are. */
export function saveFailureText(node: string, saved: readonly string[], reason: string): string {
  const done = saved.length > 0 ? ` Уже збережено: ${saved.join(", ")}.` : "";
  return `Не вдалося зберегти журнал машини "${node}": ${reason}.${done}`;
}
