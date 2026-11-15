import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { HelpRequest } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { IdPipe } from '../common/id.pipe';
import { HelpQueryDto, ReplyDto } from './dto';
import { HelpService } from './help.service';

@Controller('api/help')
export class HelpController {
  constructor(private readonly help: HelpService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: HelpQueryDto,
  ): HelpRequest[] {
    return this.help.list(user, query.open === '1');
  }

  @Post(':id/resolve')
  @HttpCode(200)
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): HelpRequest {
    return this.help.resolve(user, id);
  }

  @Post(':id/reply')
  @HttpCode(200)
  reply(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: ReplyDto,
  ): HelpRequest {
    return this.help.reply(user, id, body.branch_id);
  }
}
