import { Injectable } from '@nestjs/common';
import type { Comment, Id, Submission } from '@shared/api';
import { ActivityService } from '../activity/activity.service';
import type { AuthUser } from '../auth/auth.types';
import { badRequest, forbidden, notFound } from '../common/api-exception';
import { Clock } from '../common/clock';
import { Access } from '../classes/access.service';
import { Db } from '../db/db';
import { LtiGradesService } from '../lti/lti-grades.service';
import type { CommentDto, GradeDto } from './dto';
import { SubmissionsService } from './submissions.service';
import { SubmissionAccess } from './submission-access';

const COMMENT_NOT_FOUND = 'Коментар не знайдено';

@Injectable()
export class GradingService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly access: Access,
    private readonly rights: SubmissionAccess,
    private readonly submissions: SubmissionsService,
    private readonly activity: ActivityService,
    private readonly lti: LtiGradesService,
  ) {}

  /**
   * Sets the grade (and the overall note when given). The student is notified only when something
   * changed, and not for a teacher's own trial submission. A student who came through LTI gets
   * the grade in the LMS gradebook in the background (the link is `pending` until then); a failed
   * transfer is recorded and does not undo the grade.
   */
  grade(user: AuthUser, id: Id, dto: GradeDto): Submission {
    const view = this.rights.taught(user, id);
    if (dto.grade > view.max_grade) {
      throw badRequest(`Оцінка не може перевищувати ${view.max_grade}`);
    }
    const note = dto.note ?? view.note;
    const changed = view.grade !== dto.grade || view.note !== note;
    this.db.tx(() => {
      this.db.run(
        'UPDATE submissions SET grade = ?, note = ?, graded_by = ?, graded_at = ? WHERE id = ?',
        dto.grade,
        note,
        user.id,
        this.clock.now(),
        id,
      );
      if (changed && !view.is_preview) {
        this.activity.record({
          class_id: view.class_id,
          assignment_id: view.assignment_id,
          actor_id: user.id,
          student_id: view.student_id,
          kind: 'graded',
          ref_id: id,
          text: view.assignment_title,
        });
      }
    });
    if (!view.is_preview) {
      this.lti.queue(
        view.student_id,
        view.assignment_id,
        dto.grade,
        view.max_grade,
      );
    }
    return this.submissions.get(user, id);
  }

  addComment(user: AuthUser, id: Id, dto: CommentDto): Comment {
    const view = this.rights.taught(user, id);
    const head = this.db.get<{ event_count: number }>(
      'SELECT event_count FROM submission_journals WHERE submission_id = ? AND node_id = ?',
      id,
      dto.node,
    );
    if (!head) throw badRequest(`Машини "${dto.node}" немає у цій здачі`);
    if (dto.event_index > head.event_count) {
      throw badRequest(
        `Подія ${dto.event_index} виходить за межі журналу (${head.event_count} подій)`,
      );
    }
    const commentId = this.db.tx(() => {
      const created = this.db.run(
        `INSERT INTO comments (submission_id, node_id, event_index, vtime_ms, author_id, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        dto.node,
        dto.event_index,
        dto.vtime_ms,
        user.id,
        dto.text,
        this.clock.now(),
      );
      if (!view.is_preview) {
        this.activity.record({
          class_id: view.class_id,
          assignment_id: view.assignment_id,
          actor_id: user.id,
          student_id: view.student_id,
          kind: 'commented',
          ref_id: created.id,
          text: view.assignment_title,
        });
      }
      return created.id;
    });
    const comment = this.submissions.comment(commentId);
    if (!comment) throw new Error(`comment ${commentId} vanished after insert`);
    return comment;
  }

  /** The author or the owner of the class may delete; the row stays, hidden by `deleted_at`. */
  deleteComment(user: AuthUser, id: Id): void {
    const row = this.db.get<{ author_id: Id; class_id: Id }>(
      `SELECT c.author_id, a.class_id
       FROM comments c
       JOIN submissions s ON s.id = c.submission_id
       JOIN attempts t ON t.id = s.attempt_id
       JOIN assignments a ON a.id = t.assignment_id AND a.deleted_at IS NULL
       WHERE c.id = ? AND c.deleted_at IS NULL`,
      id,
    );
    if (!row) throw notFound(COMMENT_NOT_FOUND);
    const role = this.access.roleOf(user.id, row.class_id);
    if (role === null) throw notFound(COMMENT_NOT_FOUND);
    if (row.author_id !== user.id && role !== 'owner') {
      throw forbidden('Коментар може видалити його автор або власник класу');
    }
    this.db.run(
      'UPDATE comments SET deleted_at = ? WHERE id = ?',
      this.clock.now(),
      id,
    );
  }
}
