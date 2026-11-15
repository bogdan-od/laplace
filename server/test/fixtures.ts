import type { Topology } from '@shared/api';
import { Client } from './helpers';

export const SINGLE: Topology = {
  format: 'v86-topology/1',
  machines: [{ id: 'm1', profile: 'buildroot' }],
  switches: [],
  links: [],
};

export const PAIR: Topology = {
  format: 'v86-topology/1',
  machines: [
    { id: 'm1', profile: 'buildroot' },
    { id: 'm2', profile: 'alpine' },
  ],
  switches: [{ id: 'sw' }],
  links: [
    { machine: 'm1', switch: 'sw', mode: 'access', vlan: 1 },
    { machine: 'm2', switch: 'sw', mode: 'access', vlan: 1 },
  ],
};

export interface JournalOptions {
  profile?: string;
  events?: number;
  lesson?: boolean;
  /** Text typed in the first serial event; tests use it to look for leaks. */
  secret?: string;
  /** Swaps the c of events 1 and 2 so the order is violated. */
  broken?: boolean;
}

/** A small journal that passes check_journal_strict (no replay: the server only checks its shape). */
export function journalText(options: JournalOptions = {}): string {
  const count = options.events ?? 4;
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      t: 'serial',
      c: (i + 1) * 1000,
      w: 0,
      data: i === 0 ? (options.secret ?? 'ls\r') : 'x',
    });
  }
  if (options.broken && events.length > 2) {
    const [, second, third] = events;
    if (second && third) [second.c, third.c] = [third.c, second.c];
  }
  const header: Record<string, unknown> = {
    format: 'v86-replay/9',
    profile: options.profile ?? 'buildroot',
    seed: 7,
  };
  if (options.lesson) header.lesson = [{ t: 'note', at: 1, text: 'Увага' }];
  return JSON.stringify({ header, events });
}

export interface Item {
  id: number;
  kind: string;
  title: string;
  journals: { node: string; role: string; size: number }[];
  embed_token: string | null;
  topology: Topology;
  checks: unknown[];
  hints: unknown[];
  clip_from_ms: number | null;
}

export async function createItem(
  teacher: Client,
  body: Record<string, unknown> = {},
): Promise<Item> {
  const res = await teacher
    .post('/api/library')
    .send({
      kind: 'task',
      title: 'Налаштування мережі',
      topology: SINGLE,
      ...body,
    })
    .expect(201);
  return res.body as Item;
}

export async function putJournal(
  teacher: Client,
  itemId: number,
  text: string,
  node = 'm1',
  role = 'start',
): Promise<Item> {
  const res = await teacher
    .put(`/api/library/${itemId}/journals/${node}?role=${role}`)
    .set('Content-Type', 'application/json')
    .send(text)
    .expect(200);
  return res.body as Item;
}
