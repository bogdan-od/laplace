import { Module, OnModuleInit } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { HintUses, Progress } from '../assignments/providers';
import { ClassesModule } from '../classes/classes.module';
import { JournalAssembly } from '../journals/journal-assembly';
import { JournalsModule } from '../journals/journals.module';
import { AssignmentAttemptController } from './assignment-attempt.controller';
import { AttemptProgress } from './attempt-progress';
import { AttemptsAccess } from './attempts-access.service';
import { AttemptsController } from './attempts.controller';
import { AttemptsService } from './attempts.service';
import { BranchJournals } from './branch-journals';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';
import { HelpController } from './help.controller';
import { HelpService } from './help.service';
import { ProgressBus } from './progress-bus';
import { SubmitService } from './submit.service';
import { VerifyQueue } from './verify-queue';

@Module({
  imports: [ActivityModule, AssignmentsModule, ClassesModule, JournalsModule],
  controllers: [
    AssignmentAttemptController,
    AttemptsController,
    BranchesController,
    HelpController,
  ],
  providers: [
    AttemptProgress,
    AttemptsAccess,
    AttemptsService,
    BranchJournals,
    BranchesService,
    HelpService,
    ProgressBus,
    SubmitService,
    VerifyQueue,
  ],
  exports: [BranchJournals, ProgressBus, VerifyQueue],
})
export class AttemptsModule implements OnModuleInit {
  constructor(
    private readonly progress: Progress,
    private readonly hintUses: HintUses,
    private readonly assembly: JournalAssembly,
    private readonly attemptProgress: AttemptProgress,
    private readonly journals: BranchJournals,
  ) {}

  onModuleInit(): void {
    this.progress.use(this.attemptProgress);
    this.hintUses.use(this.attemptProgress);
    this.assembly.use(this.journals);
  }
}
