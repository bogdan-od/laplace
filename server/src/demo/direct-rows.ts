import { DatabaseSync } from 'node:sqlite';
import type { Seeded } from './seed';

const PLATFORM = {
  name: 'Moodle ліцею',
  issuer: 'https://moodle.example.org',
  client_id: 'v86-replay-demo',
  deployment_id: '1',
  auth_login_url: 'https://moodle.example.org/mod/lti/auth.php',
  token_url: 'https://moodle.example.org/mod/lti/token.php',
  jwks_url: 'https://moodle.example.org/mod/lti/certs.php',
};
const LINEITEM_BASE =
  'https://moodle.example.org/mod/lti/services.php/2/lineitems';
const SENT_STUDENT = 0;
const FAILED_STUDENT = 1;
const FAILED_TEXT =
  'Moodle відповів 401: термін дії токена платформи минув, оцінку не прийнято';
/** The assignment whose grades went to the platform. */
const GRADED_ASSIGNMENT = 'config';
const FROZEN_ASSIGNMENT = 'fw';

/**
 * Rows that no endpoint of the server can write without a network: the LMS platform with two students and
 * the result of sending their grades, and the "freeze everyone" flag. The server must be stopped.
 * Nothing here contacts the platform.
 */
export function writeDirectRows(dbFile: string, seeded: Seeded): void {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN');
    const now = Date.now();
    const platform = db
      .prepare(
        `INSERT INTO lti_platforms (owner_id, name, issuer, client_id, deployment_id,
                                    auth_login_url, token_url, jwks_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seeded.teacher.id,
        PLATFORM.name,
        PLATFORM.issuer,
        PLATFORM.client_id,
        PLATFORM.deployment_id,
        PLATFORM.auth_login_url,
        PLATFORM.token_url,
        PLATFORM.jwks_url,
        now,
      );
    const platformId = Number(platform.lastInsertRowid);
    const assignment = seeded.assignments[GRADED_ASSIGNMENT];
    const students = [SENT_STUDENT, FAILED_STUDENT].map(
      (index) => seeded.students[index],
    );
    for (const [position, student] of students.entries()) {
      if (!student || assignment === undefined)
        throw new Error('no student or assignment for the LTI rows');
      const sub = `moodle-user-${101 + position}`;
      db.prepare(
        'INSERT INTO lti_users (platform_id, sub, user_id) VALUES (?, ?, ?)',
      ).run(platformId, sub, student.id);
      const sent = position === 0;
      db.prepare(
        `INSERT INTO lti_grade_links (user_id, assignment_id, platform_id, sub, lineitem_url,
                                      status, error, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        student.id,
        assignment,
        platformId,
        sub,
        `${LINEITEM_BASE}/${assignment}/lineitem?type_id=1`,
        sent ? 'sent' : 'failed',
        sent ? null : FAILED_TEXT,
        now,
      );
    }
    db.prepare('UPDATE assignments SET frozen = 1 WHERE id = ?').run(
      seeded.assignments[FROZEN_ASSIGNMENT] ?? 0,
    );
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}
