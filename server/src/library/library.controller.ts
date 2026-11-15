import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import type {
  Assignment,
  EmbedInfo,
  LibraryItem,
  LibraryItemSummary,
} from '@shared/api';
import type { Request } from 'express';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { IdPipe } from '../common/id.pipe';
import { JournalRoleQueryDto } from '../content/dto';
import { DerivedItemsService } from './derived-items.service';
import {
  AssignDto,
  ClipDto,
  CreateItemDto,
  LessonFromSubmissionDto,
  PatchItemDto,
} from './dto';
import { EmbedService } from './embed.service';
import { LibraryJournalsService } from './library-journals.service';
import { LibraryService } from './library.service';

@Controller('api/library')
export class LibraryController {
  constructor(
    private readonly library: LibraryService,
    private readonly journals: LibraryJournalsService,
    private readonly embeds: EmbedService,
    private readonly derived: DerivedItemsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser): LibraryItemSummary[] {
    return this.library.list(user);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateItemDto,
  ): LibraryItem {
    return this.library.create(user, body);
  }

  @Post('lesson-from-submission')
  lessonFromSubmission(
    @CurrentUser() user: AuthUser,
    @Body() body: LessonFromSubmissionDto,
  ): Promise<LibraryItem> {
    return this.derived.lessonFromSubmission(user, body);
  }

  @Post('clip')
  clip(
    @CurrentUser() user: AuthUser,
    @Body() body: ClipDto,
  ): Promise<LibraryItem> {
    return this.derived.clip(user, body);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): LibraryItem {
    return this.library.get(user, id);
  }

  @Patch(':id')
  patch(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: PatchItemDto,
  ): LibraryItem {
    return this.library.patch(user, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', IdPipe) id: number): null {
    return this.library.remove(user, id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): LibraryItem {
    return this.library.restore(user, id);
  }

  /** The body is the raw journal (see large-bodies.ts), so the hash covers the bytes as sent. */
  @Put(':id/journals/:node')
  putJournal(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Param('node') node: string,
    @Query() query: JournalRoleQueryDto,
    @Req() req: Request,
  ): Promise<LibraryItem> {
    return this.journals.put(user, id, node, query.role, req.body);
  }

  @Get(':id/journals/:node')
  getJournal(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Param('node') node: string,
    @Query() query: JournalRoleQueryDto,
  ): StreamableFile {
    const { stream, size } = this.journals.open(user, id, node, query.role);
    return new StreamableFile(stream, {
      type: 'application/json',
      length: size,
    });
  }

  @Delete(':id/journals/:node')
  removeJournal(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Param('node') node: string,
    @Query() query: JournalRoleQueryDto,
  ): LibraryItem {
    return this.journals.remove(user, id, node, query.role);
  }

  @Post(':id/assign')
  assign(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: AssignDto,
  ): Assignment {
    return this.library.assign(user, id, body);
  }

  @Post(':id/embed')
  publish(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): EmbedInfo {
    return this.embeds.publish(user, id);
  }

  @Delete(':id/embed')
  revoke(@CurrentUser() user: AuthUser, @Param('id', IdPipe) id: number): null {
    return this.embeds.revoke(user, id);
  }
}
