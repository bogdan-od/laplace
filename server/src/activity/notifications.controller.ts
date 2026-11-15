import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { NotificationList } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ReadNotificationsDto } from './dto';
import { NotificationsService } from './notifications.service';

@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): NotificationList {
    return this.notifications.list(user.id);
  }

  @Post('read')
  @HttpCode(200)
  read(
    @CurrentUser() user: AuthUser,
    @Body() body: ReadNotificationsDto,
  ): null {
    this.notifications.markRead(user.id, body.up_to);
    return null;
  }
}
