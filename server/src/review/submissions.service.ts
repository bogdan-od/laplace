import { Injectable } from '@nestjs/common';
import type {
  ChunkInfo,
  CheckResult,
  CheckRun,
  CheckRunStatus,
  Comment,
  Hint,
  Id,
  LmsGrade,
  Submission,
  SubmissionJournal,
  TeacherInput,
} from '@shared/api';
import { Readable } from 'node:stream';
import type { AuthUser } from '../auth/auth.types';
import { notFound } from '../common/api-exception';
import { BranchJournals } from '../attempts/branch-journals';
import { journalSegments } from '../attempts/journal-path';
import { latestChecks, teacherInputsOf } from '../attempts/views';
import { isTeacherRole } from '../classes/access.service';
import { Db } from '../db/db';
import { clipChunk } from './growth';
import { SubmissionAccess, type SubmissionView } from './submission-access';

interface CommentRow {
  id: Id;
  submission_id: Id;
  node_id: string;
  event_index: number;
  vtime_ms: number;
  author_id: Id;
  author_name: string;
  text: string;
  created_at: number;
}

interface CheckRunRow {
  id: Id;
  submission_id: Id;
  status: CheckRunStatus;
  results: string;
  message: string | null;
  created_at: number;
  finished_at: number | null;
}

const COMMENT_SELECT = `
  SELECT c.id, c.submission_id, c.node_id, c.event_index, c.vtime_ms, c.author_id,
         u.name AS author_name, c.text, c.created_at
  FROM comments c JOIN users u ON u.id = c.author_id
  WHERE c.deleted_at IS NULL`;

export const toComment = (row: CommentRow): Comment => ({
  id: row.id,
  submission_id: row.submission_id,
  node: row.node_id,
  event_index: row.event_index,
  vtime_ms: row.vtime_ms,
  author: { id: row.author_id, name: row.author_name },
  text: row.text,
  created_at: row.created_at,
});

/** Reads submissions for the review screens. Select only: grading lives in GradingService. */
@Injectable()
export class SubmissionsService {
  constructor(
    private readonly db: Db,
    private readonly rights: SubmissionAccess,
    private readonly journals: BranchJournals,
  ) {}

  get(user: AuthUser, id: Id): Submission {
    const view = this.rights.readable(user, id);
    return this.build(view, isTeacherRole(view.role));
  }

  /** The journal of one machine exactly as submitted (cut to the submitted event count). */
  journal(user: AuthUser, id: Id, node: string): Readable {
    this.rights.readable(user, id);
    const head = this.db.get<{ branch_id: Id; event_count: number }>(
      'SELECT branch_id, event_count FROM submission_journals WHERE submission_id = ? AND node_id = ?',
      id,
      node,
    );
    if (!head) throw notFound('Журнал машини не знайдено');
    return this.journals.assemble(head.branch_id, head.event_count);
  }

  comments(submissionId: Id): Comment[] {
    return this.db
      .all<CommentRow>(
        `${COMMENT_SELECT} AND c.submission_id = ? ORDER BY c.created_at, c.id`,
        submissionId,
      )
      .map(toComment);
  }

  comment(id: Id): Comment | undefined {
    const row = this.db.get<CommentRow>(`${COMMENT_SELECT} AND c.id = ?`, id);
    return row ? toComment(row) : undefined;
  }

  /** The attempt's owner never sees what teachers typed into the machine or the check results. */
  private build(view: SubmissionView, forTeacher: boolean): Submission {
    const journals = this.db.all<SubmissionJournal & { node_id: string }>(
      `SELECT node_id, branch_id, event_count, digest FROM submission_journals
       WHERE submission_id = ? ORDER BY node_id`,
      view.id,
    );
    return {
      id: view.id,
      attempt_id: view.attempt_id,
      created_at: view.created_at,
      verify_status: view.verify_status,
      grade: view.grade,
      checks: forTeacher
        ? (latestChecks(this.db, [view.id]).get(view.id) ?? null)
        : null,
      assignment: {
        id: view.assignment_id,
        title: view.assignment_title,
        class_id: view.class_id,
        class_name: view.class_name,
        max_grade: view.max_grade,
        due_at: view.due_at,
      },
      student: { id: view.student_id, name: view.student_name },
      journals: journals.map((journal) => ({
        node: journal.node_id,
        branch_id: journal.branch_id,
        event_count: journal.event_count,
        digest: journal.digest,
      })),
      verify_message: view.verify_message,
      commands_count: view.commands_count,
      ...this.hints(view),
      note: view.note,
      graded_by: this.gradedBy(view.graded_by),
      graded_at: view.graded_at,
      comments: this.comments(view.id),
      teacher_inputs: forTeacher ? this.teacherInputs(view) : [],
      growth: journals.map((journal) => ({
        node: journal.node_id,
        chunks: this.growth(journal.branch_id, journal.event_count),
      })),
      check_runs: forTeacher ? this.checkRuns(view.id) : [],
      lms_grade: forTeacher ? this.lmsGrade(view) : null,
    };
  }

  /**
   * Hints opened by the time of the submission and the grade they leave: the maximum minus the
   * penalties, at least 0. A hint opened after a later resubmission does not cost this one.
   */
  private hints(
    view: SubmissionView,
  ): Pick<Submission, 'hints_used' | 'suggested_grade'> {
    const hints = JSON.parse(view.hints) as Hint[];
    const used = this.db
      .all<{ hint_index: number }>(
        `SELECT hint_index FROM hint_uses
         WHERE attempt_id = ? AND used_at <= ? ORDER BY hint_index`,
        view.attempt_id,
        view.created_at,
      )
      .flatMap(({ hint_index }) => {
        const hint = hints[hint_index];
        return hint ? [{ index: hint_index, penalty: hint.penalty }] : [];
      });
    const penalty = used.reduce((sum, hint) => sum + hint.penalty, 0);
    return {
      hints_used: used,
      suggested_grade: Math.max(0, view.max_grade - penalty),
    };
  }

  private lmsGrade(view: SubmissionView): LmsGrade | null {
    return (
      this.db.get<LmsGrade>(
        `SELECT status, error, sent_at FROM lti_grade_links
         WHERE user_id = ? AND assignment_id = ?`,
        view.student_id,
        view.assignment_id,
      ) ?? null
    );
  }

  private gradedBy(userId: Id | null): { id: Id; name: string } | null {
    if (userId === null) return null;
    const user = this.db.get<{ id: Id; name: string }>(
      'SELECT id, name FROM users WHERE id = ?',
      userId,
    );
    return user ?? null;
  }

  private teacherInputs(view: SubmissionView): TeacherInput[] {
    return teacherInputsOf(this.db, view.assignment_id, view.student_id);
  }

  private checkRuns(submissionId: Id): CheckRun[] {
    return this.db
      .all<CheckRunRow>(
        `SELECT id, submission_id, status, results, message, created_at, finished_at
         FROM check_runs WHERE submission_id = ? ORDER BY id`,
        submissionId,
      )
      .map((row) => ({
        id: row.id,
        submission_id: row.submission_id,
        status: row.status,
        results: JSON.parse(row.results) as CheckResult[],
        message: row.message,
        created_at: row.created_at,
        finished_at: row.finished_at,
      }));
  }

  /** Chunks along the branch path that hold the first `count` events, ancestors' chunks included. */
  private growth(branchId: Id, count: number): ChunkInfo[] {
    const path = this.journals.path(branchId);
    if (!path) return [];
    const chunks: ChunkInfo[] = [];
    for (const segment of journalSegments(path.branches, count)) {
      const stored = this.db.all<ChunkInfo>(
        `SELECT first_event, event_count, bytes, received_at FROM chunks
         WHERE branch_id = ? AND first_event < ? AND first_event + event_count > ?
         ORDER BY first_event`,
        segment.branch_id,
        segment.to,
        segment.from,
      );
      for (const chunk of stored) {
        const clipped = clipChunk(chunk, segment.from, segment.to);
        if (clipped) chunks.push(clipped);
      }
    }
    return chunks;
  }
}
