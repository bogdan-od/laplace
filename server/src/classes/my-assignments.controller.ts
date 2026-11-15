import { Controller, Get } from '@nestjs/common';
import type { MyAssignment } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ClassesService } from './classes.service';

@Controller('api/me/assignments')
export class MyAssignmentsController {
  constructor(private readonly classes: ClassesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): MyAssignment[] {
    return this.classes.myAssignments(user);
  }
}
