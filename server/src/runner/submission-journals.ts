import { Injectable } from '@nestjs/common';
import type { Id } from '@shared/api';
import { MAX_JOURNAL_BYTES } from '@shared/limits';
import type { Journal } from '@core/core/journal.mjs';
import { journalCore } from '../core';
import { ApiException } from '../common/api-exception';
import { Db } from '../db/db';
import { collect } from '../journals/collect';
import { JournalAssembly } from '../journals/journal-assembly';
import { coreMessage } from '../journals/journal-store';

const NOT_JSON_TEXT = 'Журнал не є коректним JSON';
const TOO_LARGE_TEXT = 'Журнал завеликий';

/** A journal that cannot be replayed: it is damaged or breaks the core's rules. `message` is for people. */
export class JournalRejected extends Error {
  constructor(
    readonly node: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LoadedJournal {
  node: string;
  journal: Journal;
}

/** Builds the journal of every machine of a submission and runs `check_journal_strict` on it. */
@Injectable()
export class SubmissionJournals {
  constructor(
    private readonly db: Db,
    private readonly assembly: JournalAssembly,
  ) {}

  /** Journals in the order of `order` (the machines of the topology); machines not listed come last. */
  async load(submissionId: Id, order: string[]): Promise<LoadedJournal[]> {
    const rows = this.db.all<{
      node_id: string;
      branch_id: Id;
      event_count: number;
    }>(
      'SELECT node_id, branch_id, event_count FROM submission_journals WHERE submission_id = ?',
      submissionId,
    );
    const rank = (node: string): number => {
      const index = order.indexOf(node);
      return index === -1 ? order.length : index;
    };
    rows.sort((a, b) => rank(a.node_id) - rank(b.node_id));
    const loaded: LoadedJournal[] = [];
    for (const row of rows) {
      loaded.push({
        node: row.node_id,
        journal: await this.one(row.node_id, row.branch_id, row.event_count),
      });
    }
    return loaded;
  }

  private async one(
    node: string,
    branchId: Id,
    eventCount: number,
  ): Promise<Journal> {
    let bytes: Buffer;
    try {
      const stream = await this.assembly.assemble(branchId, eventCount);
      bytes = await collect(stream, MAX_JOURNAL_BYTES);
    } catch (error) {
      if (error instanceof ApiException && error.code === 'journal_too_large') {
        throw new JournalRejected(node, TOO_LARGE_TEXT);
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString());
    } catch {
      throw new JournalRejected(node, NOT_JSON_TEXT);
    }
    try {
      return journalCore().check_journal_strict(parsed);
    } catch (error) {
      throw new JournalRejected(node, coreMessage(error));
    }
  }
}
