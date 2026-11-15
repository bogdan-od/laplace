import { Injectable } from '@nestjs/common';
import type { Id, ItemKind, SearchResult } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { Access, isTeacherRole } from '../classes/access.service';
import { Db } from '../db/db';

const MIN_QUERY_CHARS = 2;
const GROUP_LIMIT = 8;
const EMPTY: SearchResult = {
  classes: [],
  students: [],
  assignments: [],
  library: [],
};

/**
 * SQLite `lower()` leaves Cyrillic alone, so names are compared here. The candidate rows are
 * limited to the classes and the library of the user; those are small sets.
 */
const matches = (needle: string, text: string): boolean =>
  text.toLowerCase().includes(needle);

function firstMatches<T>(
  rows: readonly T[],
  text: (row: T) => string,
  needle: string,
): T[] {
  return rows.filter((row) => matches(needle, text(row))).slice(0, GROUP_LIMIT);
}

@Injectable()
export class SearchService {
  constructor(
    private readonly db: Db,
    private readonly access: Access,
  ) {}

  search(user: AuthUser, query: string): SearchResult {
    const needle = query.trim().toLowerCase();
    if ([...needle].length < MIN_QUERY_CHARS) return EMPTY;
    const roles = this.access.rolesOf(user.id);
    const classIds = [...roles.keys()];
    const teaches = classIds.filter((id) =>
      isTeacherRole(roles.get(id) ?? 'student'),
    );
    return {
      classes: firstMatches(this.classes(classIds), (row) => row.name, needle),
      students: firstMatches(
        this.students(teaches),
        (row) => row.name,
        needle,
      ).map((row) => ({
        user_id: row.user_id,
        name: row.name,
        class_id: row.class_id,
        class_name: row.class_name,
      })),
      assignments: firstMatches(
        this.assignments(classIds),
        (row) => row.title,
        needle,
      ),
      library: firstMatches(this.library(user.id), (row) => row.title, needle),
    };
  }

  private classes(ids: Id[]): { id: Id; name: string }[] {
    return this.inClasses<{ id: Id; name: string }>(
      ids,
      'SELECT id, name FROM classes WHERE id IN (%) ORDER BY name, id',
    );
  }

  /** Students of the classes the user teaches; a student does not look up classmates. */
  private students(ids: Id[]): {
    user_id: Id;
    name: string;
    class_id: Id;
    class_name: string;
  }[] {
    return this.inClasses(
      ids,
      `SELECT m.user_id, u.name, m.class_id, c.name AS class_name
       FROM class_members m JOIN users u ON u.id = m.user_id JOIN classes c ON c.id = m.class_id
       WHERE m.role = 'student' AND m.class_id IN (%) ORDER BY u.name, m.class_id`,
    );
  }

  private assignments(ids: Id[]): {
    id: Id;
    title: string;
    class_id: Id;
    class_name: string;
  }[] {
    return this.inClasses(
      ids,
      `SELECT a.id, a.title, a.class_id, c.name AS class_name
       FROM assignments a JOIN classes c ON c.id = a.class_id
       WHERE a.deleted_at IS NULL AND a.class_id IN (%) ORDER BY a.created_at DESC, a.id DESC`,
    );
  }

  private library(userId: Id): { id: Id; kind: ItemKind; title: string }[] {
    return this.db.all<{ id: Id; kind: ItemKind; title: string }>(
      `SELECT id, kind, title FROM library_items
       WHERE owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC`,
      userId,
    );
  }

  /** Runs `sql` with `%` replaced by one placeholder per class id; no ids, no rows. */
  private inClasses<T>(ids: Id[], sql: string): T[] {
    if (ids.length === 0) return [];
    return this.db.all<T>(
      sql.replace('%', ids.map(() => '?').join(', ')),
      ...ids,
    );
  }
}
