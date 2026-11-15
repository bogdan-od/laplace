import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { ClassSummary, InviteInfo } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Public } from '../auth/decorators';
import { TrimUpperPipe } from '../common/trim-upper.pipe';
import { ClassesService } from './classes.service';
import { MembershipService } from './membership.service';

@Controller('api/invites')
export class InvitesController {
  constructor(
    private readonly membership: MembershipService,
    private readonly classes: ClassesService,
  ) {}

  @Public()
  @Get(':code')
  info(@Param('code', TrimUpperPipe) code: string): InviteInfo {
    return this.membership.inviteInfo(code);
  }

  @Post(':code/accept')
  @HttpCode(200)
  accept(
    @CurrentUser() user: AuthUser,
    @Param('code', TrimUpperPipe) code: string,
  ): ClassSummary {
    return this.classes.accept(user, code);
  }
}
