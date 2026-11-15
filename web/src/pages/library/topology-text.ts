import { validate_topology } from "@core/net/topology.mjs";
import type { JournalRef, Topology } from "@shared/api";

export interface TopologyDraft {
  /** The parsed description; null while the text has errors. */
  topology: Topology | null;
  /** One line for a JSON error, else the messages of `validate_topology`; empty for a correct text. */
  problems: string[];
}

const INDENT = 2;

export function topologyText(topology: Topology): string {
  return JSON.stringify(topology, null, INDENT);
}

/** The text of the editor -> the description, or the reasons it cannot be saved. */
export function parseTopologyText(text: string): TopologyDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { topology: null, problems: [`Помилка JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const problems = validate_topology(raw);
  if (problems.length > 0) return { topology: null, problems };
  return { topology: raw as Topology, problems: [] };
}

/** The machines that have a journal on the server and are not in the new topology: the server deletes those journals. */
export function lostJournalNodes(journals: readonly JournalRef[], topology: Topology): string[] {
  const kept = new Set(topology.machines.map((machine) => machine.id));
  return [...new Set(journals.map((journal) => journal.node))].filter((node) => !kept.has(node));
}

/** The rows with a command whose machine is not among `machines`. */
export function orphanChecks<T extends { node: string; command: string }>(rows: readonly T[], machines: readonly { id: string }[]): T[] {
  return rows.filter((row) => row.command.trim() !== "" && !machines.some((machine) => machine.id === row.node));
}
