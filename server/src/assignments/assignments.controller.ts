import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import type { Assignment } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { IdPipe } from '../common/id.pipe';
import { JournalRoleQueryDto } from '../content/dto';
import { AssignmentsService } from './assignments.service';
import { PatchAssignmentDto } from './dto';

@Controller('api/assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): Assignment {
    return this.assignments.get(user, id);
  }

  @Patch(':id')
  patch(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: PatchAssignmentDto,
  ): Assignment {
    return this.assignments.patch(user, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', IdPipe) id: number): null {
    return this.assignments.remove(user, id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): Assignment {
    return this.assignments.restore(user, id);
  }

  @Get(':id/journals/:node')
  journal(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Param('node') node: string,
    @Query() query: JournalRoleQueryDto,
  ): StreamableFile {
    const { stream, size } = this.assignments.journal(
      user,
      id,
      node,
      query.role,
    );
    return new StreamableFile(stream, {
      type: 'application/json',
      length: size,
    });
  }
}
