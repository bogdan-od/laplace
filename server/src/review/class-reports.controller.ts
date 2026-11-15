import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import type { Activity } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { IdPipe } from '../common/id.pipe';
import { ClassReportsService } from './class-reports.service';
import { ActivityQueryDto } from './dto';

@Controller('api/classes')
export class ClassReportsController {
  constructor(private readonly reports: ClassReportsService) {}

  @Get(':id/grades.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="grades.csv"')
  gradesCsv(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): string {
    return this.reports.gradesCsv(user, id);
  }

  @Get(':id/activity')
  activity(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Query() query: ActivityQueryDto,
  ): Activity[] {
    return this.reports.activity(user, id, query.before);
  }
}
