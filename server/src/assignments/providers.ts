import { Injectable } from '@nestjs/common';
import type { Id, StudentProgress, TileStatus } from '@shared/api';
import type { ClassViewer } from '../classes/class-stats';

/** What assignments need from attempts and submissions, which they must not query themselves. */
export interface AssignmentProgress {
  /** Tiles of the class for a teacher; empty for a student. */
  counts: Partial<Record<TileStatus, number>>;
  /** The student's own status; null for a teacher. */
  my_status: TileStatus | null;
  /** Grade of the student's latest submission. */
  my_grade: number | null;
  my_attempt_id: Id | null;
  /** Ungraded submissions; 0 for a student. */
  to_review: number;
}

export interface ProgressProvider {
  assignment(assignmentId: Id, viewer: ClassViewer): AssignmentProgress;
  /** Ungraded submissions and open help requests of a class; zeros for a student. */
  classCounters(
    classId: Id,
    viewer: ClassViewer,
  ): { to_review: number; open_help: number };
  /** The tile of one current student of the assignment's class; null for anyone else. */
  student(assignmentId: Id, userId: Id): StudentProgress | null;
}

export const NO_ATTEMPTS: ProgressProvider = {
  assignment: (_assignmentId, viewer) =>
    viewer.role === 'student'
      ? {
          counts: {},
          my_status: 'idle',
          my_grade: null,
          my_attempt_id: null,
          to_review: 0,
        }
      : {
          counts: { stuck: 0, work: 0, done: 0, idle: 0 },
          my_status: null,
          my_grade: null,
          my_attempt_id: null,
          to_review: 0,
        },
  classCounters: () => ({ to_review: 0, open_help: 0 }),
  student: () => null,
};

/** Entry point of the assignments code. The attempts module plugs in with `use`; until then nobody has an attempt. */
@Injectable()
export class Progress implements ProgressProvider {
  private provider: ProgressProvider = NO_ATTEMPTS;

  use(provider: ProgressProvider): void {
    this.provider = provider;
  }

  assignment(assignmentId: Id, viewer: ClassViewer): AssignmentProgress {
    return this.provider.assignment(assignmentId, viewer);
  }

  classCounters(
    classId: Id,
    viewer: ClassViewer,
  ): { to_review: number; open_help: number } {
    return this.provider.classCounters(classId, viewer);
  }

  student(assignmentId: Id, userId: Id): StudentProgress | null {
    return this.provider.student(assignmentId, userId);
  }
}

export interface HintUsesProvider {
  /** Indexes of the hints the user has opened in their attempt at the assignment. */
  opened(assignmentId: Id, userId: Id): number[];
}

/** Entry point for opened hints. The attempts module plugs in with `use`; until then nothing is opened. */
@Injectable()
export class HintUses implements HintUsesProvider {
  private provider: HintUsesProvider = { opened: () => [] };

  use(provider: HintUsesProvider): void {
    this.provider = provider;
  }

  opened(assignmentId: Id, userId: Id): number[] {
    return this.provider.opened(assignmentId, userId);
  }
}
