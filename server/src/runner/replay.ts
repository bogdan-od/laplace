import type { Journal } from '@core/core/journal.mjs';
import type { MachineFactory } from './machine-factory';

const SPEED_MAX = 0;

export type ReplayVerdict =
  { kind: 'ok' } | { kind: 'failed'; message: string } | { kind: 'timeout' };

/**
 * Replays one journal flat out in its own worker and reports how it ended. The worker is gone when
 * this returns, whatever the verdict. The journal must already have passed `check_journal_strict`.
 */
export async function replayJournal(
  machines: MachineFactory,
  node: string,
  journal: Journal,
  timeoutMs: number,
): Promise<ReplayVerdict> {
  const machine = machines.create({ id: node, journal });
  const ended = new Promise<ReplayVerdict>((resolve) => {
    machine.on('end', () => resolve({ kind: 'ok' }));
    machine.on('error', (message) => resolve({ kind: 'failed', message }));
  });
  machine.set_speed(SPEED_MAX);
  const started = machine.start().then(
    () => ended,
    (error: Error): ReplayVerdict => ({
      kind: 'failed',
      message: error.message,
    }),
  );
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<ReplayVerdict>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([started, expired]);
  } finally {
    clearTimeout(timer);
    await machine.stop();
  }
}
