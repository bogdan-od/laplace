import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Journal, JournalHeader } from '@core/core/journal.mjs';
import type { ProfileName } from '@core/profiles.mjs';
import {
  hostNanCore,
  journalCore,
  macCore,
  profilesCore,
  snapfileCore,
  topologyCore,
  topologyJournalsCore,
} from '../core';
import { repoRoot } from '../repo-root';
import { ServerMachine } from '../runner/server-machine';
import type { Step } from './demo-data';
import type { CheckCommand, Topology } from '@shared/api';

const TYPE_DELAY_MS = 20;
const TYPE_JITTER_MS = 70;
const DEFAULT_WAIT_MS = 1500;
const CHECK_TIMEOUT_MS = 10_000;

export interface Recording {
  /** Journal of each machine, ending with a `check` event. */
  journals: Record<string, Journal>;
  /** Event count of each machine before every step; the last item is after the last step. */
  before: Record<string, number>[];
  /** Exit code of each check run on the live machines after the journals were taken; null when the guest did not answer. */
  checks: { title: string; rc: number | null; output: string }[];
}

async function bootClock(
  profile: ProfileName,
): Promise<{ ram: string; epoch: number }> {
  const file = profilesCore().boot_snapshot_path(`${repoRoot()}/`, profile);
  const snapshot = await snapfileCore().read_snapshot(
    new Uint8Array(readFileSync(file)),
  );
  return { ram: snapshot.clock.ram, epoch: snapshot.clock.epoch };
}

async function requireOk(
  machine: ServerMachine,
  command: string,
  what: string,
): Promise<void> {
  const result = await machine.system(command);
  if (result.rc !== 0) {
    throw new Error(
      `${machine.id}: ${what} failed with code ${result.rc}: ${result.output}`,
    );
  }
}

/** The checks of the task through the system channel, as the server's check run does, but on the live recorded machines. */
async function runChecks(
  machines: Map<string, ServerMachine>,
  checks: readonly CheckCommand[],
): Promise<Recording['checks']> {
  const results: Recording['checks'] = [];
  for (const check of checks) {
    const machine = machines.get(check.node);
    if (!machine) throw new Error(`no machine ${check.node} for a check`);
    try {
      const { rc, output } = await machine.system(check.command, {
        timeout_ms: CHECK_TIMEOUT_MS,
      });
      results.push({ title: check.title, rc, output });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      results.push({ title: check.title, rc: null, output: text });
    }
  }
  return results;
}

/**
 * Starts the machines of a topology from their boot snapshots exactly as the student's browser does
 * (fresh session, then the topology setup), types the steps like a person and returns the journals.
 */
export async function recordSession(
  topology: Topology,
  steps: readonly Step[],
  checks: readonly CheckCommand[] = [],
): Promise<Recording> {
  const clocks = new Map<ProfileName, { ram: string; epoch: number }>();
  for (const machine of topology.machines) {
    if (!clocks.has(machine.profile))
      clocks.set(machine.profile, await bootClock(machine.profile));
  }
  const headers = new Map<string, JournalHeader>();
  const seed = () => 1 + Math.floor(Math.random() * 2 ** 30);
  const built = topologyCore().build_topology<ServerMachine>(topology, {
    create_machine: (desc) => {
      const clock = clocks.get(desc.profile);
      if (!clock) throw new Error(`no boot snapshot for ${desc.profile}`);
      const header: JournalHeader = {
        format: journalCore().FORMAT,
        profile: desc.profile,
        machine: 'demo',
        seed: seed(),
        epoch: clock.epoch,
        recorded_at: new Date().toISOString(),
        rate0: null,
        host_nan: hostNanCore().host_nan(),
        start: { snapshot: `${desc.profile}-boot`, digest: clock.ram },
        parent: null,
      };
      headers.set(desc.id, header);
      return new ServerMachine({
        journal: { header, events: [] },
        id: desc.id,
      });
    },
  });
  const machines = built.machines;
  try {
    await topologyJournalsCore().launch_topology(machines, machines.keys(), {
      start: async (machine) => {
        const reply = await machine.start();
        const header = headers.get(machine.id);
        if (header) header.rate0 = reply.rate0;
      },
    });
    const profiles = profilesCore();
    for (const desc of topology.machines) {
      const machine = machines.get(desc.id);
      if (!machine) continue;
      machine.type(profiles.fresh_session_input(), 'system');
      const entropy = randomBytes(profiles.SESSION_ENTROPY_BYTES);
      await requireOk(
        machine,
        profiles.session_command(Date.now(), entropy),
        'session start',
      );
      if (desc.setup) {
        const setup = topologyCore().fill_setup(
          desc.setup,
          macCore().random_mac(),
        );
        await requireOk(machine, setup, 'setup');
      }
    }
    const counts = async (): Promise<Record<string, number>> =>
      Object.fromEntries(
        await Promise.all(
          [...machines].map(
            async ([id, machine]) =>
              [id, (await machine.journal()).events.length] as const,
          ),
        ),
      );
    const before: Record<string, number>[] = [];
    for (const step of steps) {
      before.push(await counts());
      const machine = machines.get(step.node);
      if (!machine) throw new Error(`no machine ${step.node}`);
      for (const char of step.text) {
        machine.type(char);
        await sleep(TYPE_DELAY_MS + Math.random() * TYPE_JITTER_MS);
      }
      await sleep(step.waitMs ?? DEFAULT_WAIT_MS);
    }
    before.push(await counts());
    const ids = [...machines.keys()];
    const list = await topologyJournalsCore().checked_journals(machines);
    const journals: Record<string, Journal> = {};
    ids.forEach((id, index) => {
      const journal = list[index];
      if (!journal) throw new Error(`no journal for ${id}`);
      journalCore().check_journal_strict(journal);
      journals[id] = journal;
    });
    return { journals, before, checks: await runChecks(machines, checks) };
  } finally {
    built.teardown();
    await Promise.all([...machines.values()].map((machine) => machine.stop()));
  }
}
