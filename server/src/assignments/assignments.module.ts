import { Module, OnModuleInit } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { ClassStats } from '../classes/class-stats';
import { ClassesModule } from '../classes/classes.module';
import { JournalsModule } from '../journals/journals.module';
import { AssignmentClassStats } from './assignment-class-stats';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { HintUses, Progress } from './providers';

@Module({
  imports: [ActivityModule, ClassesModule, JournalsModule],
  controllers: [AssignmentsController, CalendarController],
  providers: [
    AssignmentsService,
    AssignmentClassStats,
    CalendarService,
    HintUses,
    Progress,
  ],
  exports: [AssignmentsService, HintUses, Progress],
})
export class AssignmentsModule implements OnModuleInit {
  constructor(
    private readonly classStats: ClassStats,
    private readonly provider: AssignmentClassStats,
  ) {}

  onModuleInit(): void {
    this.classStats.use(this.provider);
  }
}
