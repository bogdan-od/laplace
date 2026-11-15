import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  StreamableFile,
} from '@nestjs/common';
import type { Comment, Submission } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { IdPipe } from '../common/id.pipe';
import { CommentDto, GradeDto } from './dto';
import { GradingService } from './grading.service';
import { SubmissionsService } from './submissions.service';

@Controller('api/submissions')
export class SubmissionsController {
  constructor(
    private readonly submissions: SubmissionsService,
    private readonly grading: GradingService,
  ) {}

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): Submission {
    return this.submissions.get(user, id);
  }

  @Get(':id/journals/:node')
  journal(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Param('node') node: string,
  ): StreamableFile {
    return new StreamableFile(this.submissions.journal(user, id, node), {
      type: 'application/json',
    });
  }

  @Put(':id/grade')
  grade(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: GradeDto,
  ): Submission {
    return this.grading.grade(user, id, body);
  }

  @Post(':id/comments')
  comment(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: CommentDto,
  ): Comment {
    return this.grading.addComment(user, id, body);
  }
}

@Controller('api/comments')
export class CommentsController {
  constructor(private readonly grading: GradingService) {}

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', IdPipe) id: number): void {
    this.grading.deleteComment(user, id);
  }
}
