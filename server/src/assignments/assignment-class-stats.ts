import { Injectable } from '@nestjs/common';
import type { AssignmentSummary, Id } from '@shared/api';
import type {
  ClassCounters,
  ClassStatsProvider,
  ClassViewer,
} from '../classes/class-stats';
import { AssignmentsService } from './assignments.service';
import { Progress } from './providers';

/** What ClassesModule shows about assignments: the list, the next due date and the attempt counters. */
@Injectable()
export class AssignmentClassStats implements ClassStatsProvider {
  constructor(
    private readonly service: AssignmentsService,
    private readonly progress: Progress,
  ) {}

  counters(classId: Id, viewer: ClassViewer): ClassCounters {
    return {
      ...this.progress.classCounters(classId, viewer),
      next_due_at: this.service.nextDueAt(classId),
    };
  }

  assignments(classId: Id, viewer: ClassViewer): AssignmentSummary[] {
    return this.service.summaries(classId, viewer);
  }
}
