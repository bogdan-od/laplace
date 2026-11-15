import type { CheckCommand, Topology } from '@shared/api';
import { badRequest } from '../common/api-exception';
import { topologyCore } from '../core';

/**
 * A topology as the server stores it: without `journals` (those live in journal files) and
 * accepted by `validate_topology`. Throws 400 `topology_invalid` joining all messages with "; ".
 */
export function cleanTopology(raw: unknown): Topology {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('Опис топології має бути об’єктом', 'topology_invalid');
  }
  const withoutJournals = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== 'journals'),
  );
  const errors = topologyCore().validate_topology(withoutJournals);
  if (errors.length > 0) {
    throw badRequest(errors.join('; '), 'topology_invalid');
  }
  // validate_topology accepted the shape, so the cast cannot lie.
  return withoutJournals as unknown as Topology;
}

/** One machine and no links: the shape a shared LAN and a lesson need. */
export const isSingleMachine = (topology: Topology): boolean =>
  topology.machines.length === 1 && topology.links.length === 0;

/** Every check runs on a machine that exists in the topology. */
export function checkNodesExist(
  checks: readonly CheckCommand[],
  topology: Topology,
): void {
  const ids = new Set(topology.machines.map((machine) => machine.id));
  for (const check of checks) {
    if (!ids.has(check.node)) {
      throw badRequest(
        `Перевірка "${check.title}": машини "${check.node}" немає в топології`,
      );
    }
  }
}
