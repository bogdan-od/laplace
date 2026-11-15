import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { ClassDetail, ClassSummary, ImportResult } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { IdPipe } from '../common/id.pipe';
import { ClassesService } from './classes.service';
import {
  AddAssistantDto,
  CreateClassDto,
  ImportCsvDto,
  PatchClassDto,
} from './dto';
import { ImportService } from './import.service';

@Controller('api/classes')
export class ClassesController {
  constructor(
    private readonly classes: ClassesService,
    private readonly importer: ImportService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser): ClassSummary[] {
    return this.classes.list(user);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateClassDto,
  ): ClassDetail {
    return this.classes.create(user, body);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): ClassDetail {
    return this.classes.detail(user, id);
  }

  @Patch(':id')
  patch(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: PatchClassDto,
  ): ClassDetail {
    return this.classes.patch(user, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', IdPipe) id: number): null {
    return this.classes.remove(user, id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): ClassDetail {
    return this.classes.restore(user, id);
  }

  @Post(':id/invite')
  @HttpCode(200)
  invite(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): ClassDetail {
    return this.classes.newInvite(user, id);
  }

  @Post(':id/import')
  import(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: ImportCsvDto,
  ): Promise<ImportResult> {
    return this.importer.importStudents(user, id, body.csv);
  }

  @Post(':id/assistants')
  addAssistant(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: AddAssistantDto,
  ): ClassDetail {
    return this.classes.addAssistant(user, id, body);
  }

  @Delete(':id/members/:userId')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Param('userId', IdPipe) userId: number,
  ): null {
    return this.classes.removeMember(user, id, userId);
  }
}
