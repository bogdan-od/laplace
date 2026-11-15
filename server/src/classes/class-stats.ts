import { Injectable } from '@nestjs/common';
import type { AssignmentSummary, ClassRole, Id, Ms } from '@shared/api';

export interface ClassViewer {
  userId: Id;
  role: ClassRole;
}

export interface ClassCounters {
  /** Ungraded submissions; 0 for a student. */
  to_review: number;
  /** Open help requests; 0 for a student. */
  open_help: number;
  next_due_at: Ms | null;
}

/** What ClassesModule needs from assignments and attempts, which it must not query itself. */
export interface ClassStatsProvider {
  counters(classId: Id, viewer: ClassViewer): ClassCounters;
  assignments(classId: Id, viewer: ClassViewer): AssignmentSummary[];
}

const EMPTY: ClassStatsProvider = {
  counters: () => ({ to_review: 0, open_help: 0, next_due_at: null }),
  assignments: () => [],
};

/**
 * Entry point used by ClassesService. Until the assignments and attempts modules plug in, it reports no assignments
 * and zero counters. Their module calls `use(provider)` in onModuleInit; ClassesModule then never has to
 * import it, so there is no module cycle.
 */
@Injectable()
export class ClassStats implements ClassStatsProvider {
  private provider: ClassStatsProvider = EMPTY;

  use(provider: ClassStatsProvider): void {
    this.provider = provider;
  }

  counters(classId: Id, viewer: ClassViewer): ClassCounters {
    return this.provider.counters(classId, viewer);
  }

  assignments(classId: Id, viewer: ClassViewer): AssignmentSummary[] {
    return this.provider.assignments(classId, viewer);
  }
}
