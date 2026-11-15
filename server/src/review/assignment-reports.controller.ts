import { Controller, Get, Param } from '@nestjs/common';
import type { Analytics, StudentProgress } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { IdPipe } from '../common/id.pipe';
import { AnalyticsService } from './analytics.service';

@Controller('api/assignments')
export class AssignmentReportsController {
  constructor(private readonly reports: AnalyticsService) {}

  @Get(':id/students')
  students(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): StudentProgress[] {
    return this.reports.students(user, id);
  }

  @Get(':id/analytics')
  analytics(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): Analytics {
    return this.reports.analytics(user, id);
  }
}
