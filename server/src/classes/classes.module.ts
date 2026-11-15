import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { UsersModule } from '../users/users.module';
import { Access } from './access.service';
import { ClassStats } from './class-stats';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { ImportService } from './import.service';
import { InvitesController } from './invites.controller';
import { MembershipService } from './membership.service';
import { MyAssignmentsController } from './my-assignments.controller';

@Module({
  imports: [ActivityModule, UsersModule],
  controllers: [ClassesController, InvitesController, MyAssignmentsController],
  providers: [
    Access,
    ClassStats,
    ClassesService,
    ImportService,
    MembershipService,
  ],
  exports: [Access, ClassStats, MembershipService],
})
export class ClassesModule {}
