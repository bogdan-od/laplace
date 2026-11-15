import { Injectable } from '@nestjs/common';
import type {
  Assignment,
  AssignBody,
  CheckCommand,
  Hint,
  Id,
  ItemKind,
  JournalRef,
  JournalRole,
  LibraryItem,
  LibraryItemSummary,
  Topology,
} from '@shared/api';
import { UNDO_MS } from '@shared/limits';
import type { ItemSnapshot } from '../assignments/assignments.service';
import { AssignmentsService } from '../assignments/assignments.service';
import type { AuthUser } from '../auth/auth.types';
import { badRequest, forbidden, notFound } from '../common/api-exception';
import { Clock } from '../common/clock';
import { checkNodesExist, cleanTopology } from '../content/rules';
import { Db } from '../db/db';
import type { CreateItemDto, PatchItemDto } from './dto';

const RESTORE_WINDOW_MS = UNDO_MS * 6;
const NOT_FOUND_TEXT = 'Предмет не знайдено';

export interface ItemRow {
  id: Id;
  owner_id: Id;
  kind: ItemKind;
  title: string;
  brief: string;
  topology: string;
  checks: string;
  hints: string;
  clip_from_ms: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** Columns of library_items are written by this module only, so the JSON in them is ours. */
const parseJson = <T>(text: string): T => JSON.parse(text) as T;

/** Lessons and clips show one machine's journal. */
export function requireOneMachine(kind: ItemKind, topology: Topology): void {
  if (kind !== 'task' && topology.machines.length !== 1) {
    throw badRequest(
      kind === 'lesson'
        ? 'Урок має містити рівно одну машину'
        : 'Фрагмент має містити рівно одну машину',
    );
  }
}

@Injectable()
export class LibraryService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly assignments: AssignmentsService,
  ) {}

  list(user: AuthUser): LibraryItemSummary[] {
    this.requireTeacher(user);
    const rows = this.db.all<ItemRow>(
      `SELECT * FROM library_items WHERE owner_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC, id DESC`,
      user.id,
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      machines: this.topologyOf(row).machines.length,
      updated_at: row.updated_at,
      assigned: this.db.all<LibraryItemSummary['assigned'][number]>(
        `SELECT a.class_id, c.name AS class_name, a.id AS assignment_id
         FROM assignments a JOIN classes c ON c.id = a.class_id
         WHERE a.item_id = ? AND a.deleted_at IS NULL AND c.deleted_at IS NULL
         ORDER BY a.id`,
        row.id,
      ),
    }));
  }

  create(user: AuthUser, dto: CreateItemDto): LibraryItem {
    this.requireTeacher(user);
    const topology = cleanTopology(dto.topology);
    requireOneMachine(dto.kind, topology);
    return this.view(
      this.insert(user, dto.kind, dto.title, dto.brief ?? '', topology, null),
    );
  }

  get(user: AuthUser, id: Id): LibraryItem {
    return this.view(this.owned(user, id));
  }

  patch(user: AuthUser, id: Id, dto: PatchItemDto): LibraryItem {
    const row = this.owned(user, id);
    const oldTopology = this.topologyOf(row);
    const topology = dto.topology ? cleanTopology(dto.topology) : oldTopology;
    requireOneMachine(row.kind, topology);
    const checks = dto.checks ?? parseJson<CheckCommand[]>(row.checks);
    checkNodesExist(checks, topology);
    const clipFrom =
      dto.clip_from_ms === undefined ? row.clip_from_ms : dto.clip_from_ms;
    if (clipFrom !== null && row.kind !== 'clip') {
      throw badRequest('Початок показу задається лише для фрагмента');
    }
    this.db.tx(() => {
      if (dto.topology) this.reconcileJournals(id, oldTopology, topology);
      this.db.run(
        `UPDATE library_items
         SET title = ?, brief = ?, topology = ?, checks = ?, hints = ?, clip_from_ms = ?, updated_at = ?
         WHERE id = ?`,
        dto.title ?? row.title,
        dto.brief ?? row.brief,
        JSON.stringify(topology),
        JSON.stringify(checks),
        JSON.stringify(dto.hints ?? parseJson<Hint[]>(row.hints)),
        clipFrom,
        this.clock.now(),
        id,
      );
    });
    return this.get(user, id);
  }

  remove(user: AuthUser, id: Id): null {
    this.owned(user, id);
    this.db.run(
      'UPDATE library_items SET deleted_at = ? WHERE id = ?',
      this.clock.now(),
      id,
    );
    return null;
  }

  /** Undo of remove(), valid for RESTORE_WINDOW_MS; restoring a live item returns it. */
  restore(user: AuthUser, id: Id): LibraryItem {
    this.requireTeacher(user);
    const row = this.find(id);
    if (!row || row.owner_id !== user.id) throw notFound(NOT_FOUND_TEXT);
    if (row.deleted_at !== null) {
      if (this.clock.now() - row.deleted_at > RESTORE_WINDOW_MS) {
        throw notFound(NOT_FOUND_TEXT);
      }
      this.db.run(
        'UPDATE library_items SET deleted_at = NULL WHERE id = ?',
        id,
      );
    }
    return this.get(user, id);
  }

  assign(user: AuthUser, id: Id, body: AssignBody): Assignment {
    const row = this.owned(user, id);
    if (row.kind === 'clip') {
      throw badRequest('Фрагмент не можна видати як завдання');
    }
    const snapshot: ItemSnapshot = {
      item_id: row.id,
      kind: row.kind,
      title: row.title,
      brief: row.brief,
      topology: this.topologyOf(row),
      checks: parseJson<CheckCommand[]>(row.checks),
      hints: parseJson<Hint[]>(row.hints),
      journals: this.db.all<{
        node: string;
        role: JournalRole;
        sha256: string;
      }>(
        `SELECT node_id AS node, role, journal_sha AS sha256 FROM item_journals WHERE item_id = ?`,
        id,
      ),
    };
    return this.assignments.createFromItem(user, snapshot, body);
  }

  /** A new item for the user; used by create() and by lesson/clip creation. */
  insert(
    user: AuthUser,
    kind: ItemKind,
    title: string,
    brief: string,
    topology: Topology,
    clipFromMs: number | null,
  ): ItemRow {
    const now = this.clock.now();
    const { id } = this.db.run(
      `INSERT INTO library_items
         (owner_id, kind, title, brief, topology, clip_from_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id,
      kind,
      title,
      brief,
      JSON.stringify(topology),
      clipFromMs,
      now,
      now,
    );
    const row = this.find(id);
    if (!row) throw new Error(`library item ${id} vanished after insert`);
    return row;
  }

  /** The user's own live item. Students have no library (403); another teacher's item is 404. */
  owned(user: AuthUser, id: Id): ItemRow {
    this.requireTeacher(user);
    const row = this.find(id);
    if (!row || row.owner_id !== user.id || row.deleted_at !== null) {
      throw notFound(NOT_FOUND_TEXT);
    }
    return row;
  }

  requireTeacher(user: AuthUser): void {
    if (user.role !== 'teacher') {
      throw forbidden('Бібліотека доступна лише вчителям');
    }
  }

  topologyOf(row: ItemRow): Topology {
    return parseJson<Topology>(row.topology);
  }

  view(row: ItemRow): LibraryItem {
    const token = this.db.get<{ token: string }>(
      `SELECT token FROM embeds WHERE item_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC, rowid DESC`,
      row.id,
    );
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      brief: row.brief,
      topology: this.topologyOf(row),
      checks: parseJson<CheckCommand[]>(row.checks),
      hints: parseJson<Hint[]>(row.hints),
      journals: this.db.all<JournalRef>(
        `SELECT j.node_id AS node, j.role, f.size
         FROM item_journals j JOIN journal_files f ON f.sha256 = j.journal_sha
         WHERE j.item_id = ? ORDER BY j.node_id, j.role`,
        row.id,
      ),
      clip_from_ms: row.clip_from_ms,
      embed_token: token?.token ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  find(id: Id): ItemRow | undefined {
    return this.db.get<ItemRow>('SELECT * FROM library_items WHERE id = ?', id);
  }

  /** Journals follow their machines: one of a removed machine goes, a machine may not change profile under one. */
  private reconcileJournals(
    itemId: Id,
    before: Topology,
    after: Topology,
  ): void {
    const profiles = new Map(before.machines.map((m) => [m.id, m.profile]));
    const nextProfiles = new Map(after.machines.map((m) => [m.id, m.profile]));
    const nodes = this.db.all<{ node_id: string }>(
      'SELECT DISTINCT node_id FROM item_journals WHERE item_id = ?',
      itemId,
    );
    for (const { node_id: node } of nodes) {
      const next = nextProfiles.get(node);
      if (next === undefined) {
        this.db.run(
          'DELETE FROM item_journals WHERE item_id = ? AND node_id = ?',
          itemId,
          node,
        );
      } else if (next !== profiles.get(node)) {
        throw badRequest(
          `Машина "${node}" має журнал: щоб змінити профіль, спершу видаліть журнал`,
        );
      }
    }
  }
}
