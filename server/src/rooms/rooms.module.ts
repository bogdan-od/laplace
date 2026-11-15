import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { AttemptsModule } from '../attempts/attempts.module';
import { AuthModule } from '../auth/auth.module';
import { ClassesModule } from '../classes/classes.module';
import { RunnerModule } from '../runner/runner.module';
import { Connections } from './connections';
import { PersonalMessages } from './personal-messages';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';
import { TeacherInputs } from './teacher-inputs';
import { Tiles } from './tiles';
import { WsConfig } from './ws-config';

@Module({
  imports: [
    ActivityModule,
    AssignmentsModule,
    AttemptsModule,
    AuthModule,
    ClassesModule,
    RunnerModule,
  ],
  providers: [
    Connections,
    PersonalMessages,
    RoomsGateway,
    RoomsService,
    TeacherInputs,
    Tiles,
    WsConfig,
  ],
})
export class RoomsModule {}
