import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import type { AppendResult, BranchDetail, ChunkInfo } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { IdPipe } from '../common/id.pipe';
import { BranchesService } from './branches.service';
import { AppendEventsDto, JournalQueryDto } from './dto';

@Controller('api/branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  /** The body limit of this route is set in common/large-bodies.ts. */
  @Put(':id/events')
  append(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: AppendEventsDto,
  ): AppendResult {
    return this.branches.append(user, id, body);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): BranchDetail {
    return this.branches.detail(user, id);
  }

  @Get(':id/journal')
  journal(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Query() query: JournalQueryDto,
  ): StreamableFile {
    return new StreamableFile(this.branches.journal(user, id, query.to), {
      type: 'application/json',
    });
  }

  @Get(':id/chunks')
  chunks(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): ChunkInfo[] {
    return this.branches.chunks(user, id);
  }
}
