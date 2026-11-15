import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type {
  Attempt,
  Branch,
  HelpRequest,
  HintSlot,
  SubmissionSummary,
} from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { IdPipe } from '../common/id.pipe';
import { AttemptsService } from './attempts.service';
import { BranchesService } from './branches.service';
import { CreateBranchDto, HelpDto, SetHeadDto, SubmitDto } from './dto';
import { HelpService } from './help.service';
import { IndexPipe } from './index.pipe';
import { SubmitService } from './submit.service';

@Controller('api/attempts')
export class AttemptsController {
  constructor(
    private readonly attempts: AttemptsService,
    private readonly branches: BranchesService,
    private readonly help: HelpService,
    private readonly submissions: SubmitService,
  ) {}

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', IdPipe) id: number): Attempt {
    return this.attempts.get(user, id);
  }

  @Post(':id/branches')
  createBranch(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: CreateBranchDto,
  ): Branch {
    return this.branches.create(user, id, body);
  }

  @Post(':id/heads')
  @HttpCode(200)
  setHead(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: SetHeadDto,
  ): Attempt {
    return this.attempts.setHead(user, id, body.node, body.branch_id);
  }

  @Post(':id/help')
  requestHelp(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: HelpDto,
  ): HelpRequest {
    return this.help.request(user, id, body);
  }

  @Post(':id/hints/:index')
  @HttpCode(200)
  openHint(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Param('index', IndexPipe) index: number,
  ): HintSlot {
    return this.attempts.openHint(user, id, index);
  }

  @Post(':id/submit')
  submit(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
    @Body() body: SubmitDto,
  ): SubmissionSummary {
    return this.submissions.submit(user, id, body);
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @CurrentUser() user: AuthUser,
    @Param('id', IdPipe) id: number,
  ): Attempt {
    return this.attempts.complete(user, id);
  }
}
