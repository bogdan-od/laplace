import { Module } from '@nestjs/common';
import { ActivityService } from './activity.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [ActivityService, NotificationsService],
  exports: [ActivityService],
})
export class ActivityModule {}
