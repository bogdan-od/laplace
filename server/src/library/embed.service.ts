import { Injectable, StreamableFile } from '@nestjs/common';
import type { EmbedInfo, Id } from '@shared/api';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AuthUser } from '../auth/auth.types';
import { badRequest, notFound } from '../common/api-exception';
import { Clock } from '../common/clock';
import { Db } from '../db/db';
import { JournalStore } from '../journals/journal-store';
import { LibraryService } from './library.service';

const TOKEN_BYTES = 16;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const EMBED_PATH = '/embed/';

interface PublishedRow {
  title: string;
  clip_from_ms: number | null;
  journal_sha: string;
}

/**
 * Publication for the embedded player: the one way a journal is readable without logging in.
 * It is the author's explicit choice, so the project's journal secrecy rule does not apply to it.
 */
@Injectable()
export class EmbedService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly library: LibraryService,
    private readonly store: JournalStore,
  ) {}

  /** Publishes the item; publishing an already published item returns the existing token. */
  publish(user: AuthUser, id: Id): EmbedInfo {
    const row = this.library.owned(user, id);
    if (row.kind === 'task') {
      throw badRequest('Публікувати можна лише урок або фрагмент');
    }
    const journal = this.db.get<{ one: number }>(
      "SELECT 1 AS one FROM item_journals WHERE item_id = ? AND role = 'start'",
      id,
    );
    if (!journal) throw badRequest('Спершу додайте журнал');
    const existing = this.db.get<{ token: string }>(
      'SELECT token FROM embeds WHERE item_id = ? AND revoked_at IS NULL',
      id,
    );
    const token = existing?.token ?? this.createToken(id, user.id);
    return { token, url: `${EMBED_PATH}${token}` };
  }

  revoke(user: AuthUser, id: Id): null {
    this.library.owned(user, id);
    this.db.run(
      'UPDATE embeds SET revoked_at = ? WHERE item_id = ? AND revoked_at IS NULL',
      this.clock.now(),
      id,
    );
    return null;
  }

  /**
   * `{title, journal, from_ms}` with the journal file streamed into place, so a 64 MiB journal is
   * neither parsed nor held in memory.
   */
  payload(token: string): StreamableFile {
    const row = TOKEN_RE.test(token)
      ? this.db.get<PublishedRow>(
          `SELECT i.title, i.clip_from_ms, j.journal_sha
           FROM embeds e
           JOIN library_items i ON i.id = e.item_id
           JOIN item_journals j ON j.item_id = i.id AND j.role = 'start'
           WHERE e.token = ? AND e.revoked_at IS NULL AND i.deleted_at IS NULL
           LIMIT 1`,
          token,
        )
      : undefined;
    if (!row) throw notFound('Публікацію не знайдено');
    const head = Buffer.from(
      `{"title":${JSON.stringify(row.title)},"journal":`,
    );
    const tail = Buffer.from(`,"from_ms":${JSON.stringify(row.clip_from_ms)}}`);
    const file = this.store.open(row.journal_sha);
    const size = this.store.size(row.journal_sha);
    async function* body(): AsyncGenerator<Buffer> {
      yield head;
      for await (const part of file) yield part as Buffer;
      yield tail;
    }
    return new StreamableFile(Readable.from(body()), {
      type: 'application/json',
      length: head.length + size + tail.length,
    });
  }

  private createToken(itemId: Id, userId: Id): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.db.run(
      'INSERT INTO embeds (token, item_id, created_by, created_at) VALUES (?, ?, ?, ?)',
      token,
      itemId,
      userId,
      this.clock.now(),
    );
    return token;
  }
}
