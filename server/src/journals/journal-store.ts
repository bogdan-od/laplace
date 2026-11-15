import { Injectable } from '@nestjs/common';
import type { Journal } from '@shared/api';
import { MAX_JOURNAL_BYTES } from '@shared/limits';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { journalCore } from '../core';
import { ApiException, badRequest, notFound } from '../common/api-exception';
import { Clock } from '../common/clock';
import { Db } from '../db/db';
import { repoRoot } from '../repo-root';

const JOURNALS_DIR = join('data', 'journals');
const SHA256_RE = /^[0-9a-f]{64}$/;
/** Core messages can echo header fields of the upload; cap them before they reach a response. */
const MAX_CORE_MESSAGE_CHARS = 300;
const UNKNOWN_SHAPE_TEXT = 'Журнал пошкоджено: неочікувана структура';

/** The journals directory: `LAPLACE_JOURNALS`, or `data/journals/` in the repository. */
export const journalsDir = (): string =>
  process.env.LAPLACE_JOURNALS ?? join(repoRoot(), JOURNALS_DIR);

/** The text of a core error, which names the failing event but never contains the journal body. */
export function coreMessage(error: unknown): string {
  // A TypeError comes from a shape the core did not anticipate; its English text is of no use.
  if (!(error instanceof Error) || error instanceof TypeError) {
    return UNKNOWN_SHAPE_TEXT;
  }
  return error.message.slice(0, MAX_CORE_MESSAGE_CHARS);
}

/**
 * Content-addressed journal files `<dir>/<sha256>.json`. Library items and assignments refer to
 * them by hash, so the same journal is stored once. The journal text itself never reaches a log or
 * an error message: only the core's description of the failing event does.
 */
@Injectable()
export class JournalStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Size check, JSON parse and `check_journal_strict`. Throws 413 or 400 `journal_invalid`. */
  parse(content: Buffer | string): Journal {
    const size =
      typeof content === 'string' ? Buffer.byteLength(content) : content.length;
    if (size > MAX_JOURNAL_BYTES) {
      throw new ApiException(413, 'Журнал завеликий', 'journal_too_large');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.toString());
    } catch {
      throw badRequest('Журнал не є коректним JSON', 'journal_invalid');
    }
    try {
      return journalCore().check_journal_strict(parsed);
    } catch (error) {
      throw badRequest(coreMessage(error), 'journal_invalid');
    }
  }

  /**
   * Validates the journal, lets `accept` apply the caller's own rules (it throws to refuse), then
   * stores it. Returns the sha256 of the bytes as they came. Storing the same journal again
   * writes nothing.
   */
  async put(
    content: Buffer | string,
    accept?: (journal: Journal) => void,
  ): Promise<string> {
    const bytes =
      typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const journal = this.parse(bytes);
    accept?.(journal);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.writeFile(sha256, bytes);
    this.db.run(
      'INSERT OR IGNORE INTO journal_files (sha256, size, created_at) VALUES (?, ?, ?)',
      sha256,
      bytes.length,
      this.clock.now(),
    );
    return sha256;
  }

  /** The journal as a byte stream, so a 64 MiB file is never held in memory by the caller. */
  open(sha256: string): ReadStream {
    this.size(sha256);
    return createReadStream(this.pathOf(sha256));
  }

  /** Size in bytes. Throws 404 for a hash the store does not know. */
  size(sha256: string): number {
    const row = SHA256_RE.test(sha256)
      ? this.db.get<{ size: number }>(
          'SELECT size FROM journal_files WHERE sha256 = ?',
          sha256,
        )
      : undefined;
    if (!row) throw notFound('Журнал не знайдено');
    return row.size;
  }

  private pathOf(sha256: string): string {
    return join(journalsDir(), `${sha256}.json`);
  }

  private async writeFile(sha256: string, bytes: Buffer): Promise<void> {
    const target = this.pathOf(sha256);
    try {
      await access(target);
      return;
    } catch {
      // Not on disk yet.
    }
    await mkdir(journalsDir(), { recursive: true });
    const temp = join(journalsDir(), `.tmp-${randomBytes(8).toString('hex')}`);
    try {
      await writeFile(temp, bytes);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
