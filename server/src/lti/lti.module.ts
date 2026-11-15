import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClassesModule } from '../classes/classes.module';
import { UsersModule } from '../users/users.module';
import { LtiController } from './lti.controller';
import { LtiGradesService } from './lti-grades.service';
import { LtiKeysService } from './lti-keys.service';
import { LtiLaunchService } from './lti-launch.service';
import { LtiPlatformsService } from './lti-platforms.service';

@Module({
  imports: [AuthModule, ClassesModule, UsersModule],
  controllers: [LtiController],
  providers: [
    LtiGradesService,
    LtiKeysService,
    LtiLaunchService,
    LtiPlatformsService,
  ],
  exports: [LtiGradesService],
})
export class LtiModule {}
