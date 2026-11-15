import { Injectable } from '@nestjs/common';
import type { Id, JournalEvent } from '@shared/api';
import { Readable } from 'node:stream';
import { notFound } from '../common/api-exception';
import { Db } from '../db/db';
import type { JournalAssembler } from '../journals/journal-assembly';
import { journalSegments, type PathBranch, type Segment } from './journal-path';

const NOT_FOUND_TEXT = 'Спробу не знайдено';

interface BranchRow extends PathBranch {
  parent_id: Id | null;
  header: string;
}

interface ChunkRow {
  first_event: number;
  event_count: number;
  events: string;
}

/** The branch chain from the root to the branch, with the header of the last one. */
export interface BranchPath {
  branches: PathBranch[];
  /** JSON text of the target branch's header. */
  header: string;
}

/**
 * Reads the journals of branches back from their chunks. This is the single place where a branch
 * journal is assembled: rollback, a teacher's reply, "continue from here" and submissions all use
 * it, so the fork logic lives in `journalSegments` only.
 */
@Injectable()
export class BranchJournals implements JournalAssembler {
  constructor(private readonly db: Db) {}

  /** Root first. Undefined when there is no such branch. */
  path(branchId: Id): BranchPath | undefined {
    const chain: BranchRow[] = [];
    let next: Id | null = branchId;
    while (next !== null) {
      const row: BranchRow | undefined = this.db.get<BranchRow>(
        `SELECT id, parent_id, fork_event, event_count, bytes, header FROM branches WHERE id = ?`,
        next,
      );
      if (!row) return undefined;
      chain.push(row);
      next = row.parent_id;
    }
    const target = chain[0];
    if (!target) return undefined;
    return { branches: chain.reverse(), header: target.header };
  }

  /** The journal of the branch cut to its first `to` events, as JSON text pieces. */
  assemble(branchId: Id, to?: number): Readable {
    const path = this.path(branchId);
    if (!path) throw notFound(NOT_FOUND_TEXT);
    const segments = journalSegments(path.branches, to);
    return Readable.from(this.pieces(path.header, segments));
  }

  /** The events themselves, for the digest of a submission; large journals are streamed by `assemble`. */
  events(branchId: Id, to: number): JournalEvent[] {
    const path = this.path(branchId);
    if (!path) throw notFound(NOT_FOUND_TEXT);
    const events: JournalEvent[] = [];
    for (const segment of journalSegments(path.branches, to)) {
      let cursor = segment.from;
      while (cursor < segment.to) {
        const chunk = this.chunkAt(segment.branch_id, cursor);
        const end = chunk.first_event + chunk.event_count;
        const parsed = JSON.parse(chunk.events) as JournalEvent[];
        events.push(
          ...parsed.slice(
            cursor - chunk.first_event,
            Math.min(end, segment.to) - chunk.first_event,
          ),
        );
        cursor = end;
      }
    }
    return events;
  }

  /** `c` and `w` of the event number `count - 1` of the path's journal; null for an empty journal. */
  lastEvent(
    path: readonly PathBranch[],
    count: number,
  ): { c: number; w: number } | null {
    if (count === 0) return null;
    const last = journalSegments(path, count).at(-1);
    if (!last) return null;
    const chunk = this.chunkAt(last.branch_id, last.to - 1);
    const events = JSON.parse(chunk.events) as { c: number; w: number }[];
    const event = events[last.to - 1 - chunk.first_event];
    if (!event) throw new Error(`event ${last.to - 1} missing in a chunk`);
    return { c: event.c, w: event.w };
  }

  private *pieces(header: string, segments: Segment[]): Generator<string> {
    yield `{"header":${header},"events":[`;
    let first = true;
    for (const segment of segments) {
      let cursor = segment.from;
      while (cursor < segment.to) {
        const chunk = this.chunkAt(segment.branch_id, cursor);
        const end = chunk.first_event + chunk.event_count;
        const text = this.sliceEvents(chunk, cursor, Math.min(end, segment.to));
        cursor = end;
        yield first ? text : `,${text}`;
        first = false;
      }
    }
    yield ']}';
  }

  /** The chunk of the branch that holds event `index`. */
  private chunkAt(branchId: Id, index: number): ChunkRow {
    const chunk = this.db.get<ChunkRow>(
      `SELECT first_event, event_count, events FROM chunks
       WHERE branch_id = ? AND first_event <= ? ORDER BY first_event DESC LIMIT 1`,
      branchId,
      index,
    );
    if (!chunk || chunk.first_event + chunk.event_count <= index) {
      throw new Error(`branch ${branchId} has no chunk for event ${index}`);
    }
    return chunk;
  }

  /** Events [from, to) of a chunk without the surrounding brackets; whole chunks are not re-parsed. */
  private sliceEvents(chunk: ChunkRow, from: number, to: number): string {
    const lo = from - chunk.first_event;
    const hi = to - chunk.first_event;
    if (lo === 0 && hi === chunk.event_count) return chunk.events.slice(1, -1);
    const events = JSON.parse(chunk.events) as unknown[];
    return JSON.stringify(events.slice(lo, hi)).slice(1, -1);
  }
}
