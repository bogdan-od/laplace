import { Module } from '@nestjs/common';
import { ActivityModule } from './activity/activity.module';
import { AssignmentsModule } from './assignments/assignments.module';
import { AttemptsModule } from './attempts/attempts.module';
import { AuthModule } from './auth/auth.module';
import { ClassesModule } from './classes/classes.module';
import { ClockModule } from './common/clock';
import { DbModule } from './db/db.module';
import { JournalsModule } from './journals/journals.module';
import { LibraryModule } from './library/library.module';
import { LtiModule } from './lti/lti.module';
import { ReviewModule } from './review/review.module';
import { RoomsModule } from './rooms/rooms.module';
import { RunnerModule } from './runner/runner.module';
import { ImagesController } from './images/images.controller';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ClockModule,
    DbModule,
    UsersModule,
    ActivityModule,
    ClassesModule,
    AuthModule,
    JournalsModule,
    AssignmentsModule,
    LibraryModule,
    AttemptsModule,
    RunnerModule,
    ReviewModule,
    RoomsModule,
    LtiModule,
  ],
  controllers: [ImagesController],
})
export class AppModule {}
