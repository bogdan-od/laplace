import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { AttemptsModule } from '../attempts/attempts.module';
import { ClassesModule } from '../classes/classes.module';
import { JournalsModule } from '../journals/journals.module';
import { CheckRunner } from './check-runner';
import { MachineFactory } from './machine-factory';
import { RunnerBus } from './runner-bus';
import { RunnerConfig } from './runner-config';
import {
  AssignmentRunnerController,
  SubmissionRunnerController,
} from './runner.controller';
import { RunnerService } from './runner.service';
import { SlotPool } from './slot-pool';
import { SubmissionJournals } from './submission-journals';
import { SubmissionLookup } from './submission-lookup';
import { VerifyRunner } from './verify-runner';

@Module({
  imports: [ActivityModule, AttemptsModule, ClassesModule, JournalsModule],
  controllers: [SubmissionRunnerController, AssignmentRunnerController],
  providers: [
    CheckRunner,
    MachineFactory,
    RunnerBus,
    RunnerConfig,
    RunnerService,
    SlotPool,
    SubmissionJournals,
    SubmissionLookup,
    VerifyRunner,
  ],
  exports: [RunnerBus, VerifyRunner, CheckRunner, MachineFactory],
})
export class RunnerModule {}
