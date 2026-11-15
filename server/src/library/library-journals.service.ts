import { Injectable } from '@nestjs/common';
import type { Id, JournalRole, LibraryItem } from '@shared/api';
import type { ReadStream } from 'node:fs';
import type { AuthUser } from '../auth/auth.types';
import { badRequest, notFound } from '../common/api-exception';
import { Clock } from '../common/clock';
import { Db } from '../db/db';
import { JournalStore } from '../journals/journal-store';
import { LibraryService } from './library.service';

const PROFILE_SHOWN_CHARS = 40;

@Injectable()
export class LibraryJournalsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly library: LibraryService,
    private readonly store: JournalStore,
  ) {}

  /** `content` is the exact request body (a Buffer from the raw parser), hashed as it came. */
  async put(
    user: AuthUser,
    id: Id,
    node: string,
    role: JournalRole,
    content: unknown,
  ): Promise<LibraryItem> {
    const row = this.library.owned(user, id);
    const machine = this.library
      .topologyOf(row)
      .machines.find((candidate) => candidate.id === node);
    if (!machine) throw badRequest(`Машини "${node}" немає в топології`);
    if (role === 'reference' && row.kind !== 'task') {
      throw badRequest('Еталонний журнал є лише в завдань');
    }
    if (!Buffer.isBuffer(content)) {
      throw badRequest('Очікується журнал у форматі JSON', 'journal_invalid');
    }
    const sha256 = await this.store.put(content, (journal) => {
      if (journal.header.profile !== machine.profile) {
        const shown = String(journal.header.profile).slice(
          0,
          PROFILE_SHOWN_CHARS,
        );
        throw badRequest(
          `Профіль журналу "${shown}" не збігається з профілем машини "${machine.profile}"`,
          'journal_invalid',
        );
      }
      if (
        row.kind === 'lesson' &&
        role === 'start' &&
        journal.header.lesson === undefined
      ) {
        throw badRequest(
          'Журнал уроку має містити розмітку (header.lesson)',
          'journal_invalid',
        );
      }
    });
    this.db.tx(() => {
      this.db.run(
        `INSERT OR REPLACE INTO item_journals (item_id, node_id, role, journal_sha)
         VALUES (?, ?, ?, ?)`,
        id,
        node,
        role,
        sha256,
      );
      this.touch(id);
    });
    return this.library.get(user, id);
  }

  open(
    user: AuthUser,
    id: Id,
    node: string,
    role: JournalRole,
  ): { stream: ReadStream; size: number } {
    this.library.owned(user, id);
    const sha256 = this.shaOf(id, node, role);
    return { stream: this.store.open(sha256), size: this.store.size(sha256) };
  }

  remove(user: AuthUser, id: Id, node: string, role: JournalRole): LibraryItem {
    this.library.owned(user, id);
    this.shaOf(id, node, role);
    this.db.tx(() => {
      this.db.run(
        'DELETE FROM item_journals WHERE item_id = ? AND node_id = ? AND role = ?',
        id,
        node,
        role,
      );
      this.touch(id);
    });
    return this.library.get(user, id);
  }

  private shaOf(id: Id, node: string, role: JournalRole): string {
    const row = this.db.get<{ journal_sha: string }>(
      'SELECT journal_sha FROM item_journals WHERE item_id = ? AND node_id = ? AND role = ?',
      id,
      node,
      role,
    );
    if (!row) throw notFound('Журнал не знайдено');
    return row.journal_sha;
  }

  private touch(id: Id): void {
    this.db.run(
      'UPDATE library_items SET updated_at = ? WHERE id = ?',
      this.clock.now(),
      id,
    );
  }
}
