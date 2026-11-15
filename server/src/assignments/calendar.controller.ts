import { Controller, Get, Header, Query } from '@nestjs/common';
import type { CalendarEntry } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { CalendarService } from './calendar.service';
import { CalendarQueryDto } from './dto';

@Controller('api')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('calendar')
  entries(
    @CurrentUser() user: AuthUser,
    @Query() query: CalendarQueryDto,
  ): CalendarEntry[] {
    return this.calendar.entries(user, query.from, query.to);
  }

  @Get('calendar.ics')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="laplace.ics"')
  ics(@CurrentUser() user: AuthUser): string {
    return this.calendar.ics(user);
  }
}
