import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { AttemptsModule } from '../attempts/attempts.module';
import { ClassesModule } from '../classes/classes.module';
import { LtiModule } from '../lti/lti.module';
import { AnalyticsService } from './analytics.service';
import { AssignmentReportsController } from './assignment-reports.controller';
import { ClassReportsController } from './class-reports.controller';
import { ClassReportsService } from './class-reports.service';
import { GradingService } from './grading.service';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SubmissionAccess } from './submission-access';
import {
  CommentsController,
  SubmissionsController,
} from './submissions.controller';
import { SubmissionsService } from './submissions.service';

@Module({
  imports: [
    ActivityModule,
    AssignmentsModule,
    AttemptsModule,
    ClassesModule,
    LtiModule,
  ],
  controllers: [
    AssignmentReportsController,
    ClassReportsController,
    CommentsController,
    ReviewController,
    SearchController,
    SubmissionsController,
  ],
  providers: [
    AnalyticsService,
    ClassReportsService,
    GradingService,
    ReviewService,
    SearchService,
    SubmissionAccess,
    SubmissionsService,
  ],
})
export class ReviewModule {}
