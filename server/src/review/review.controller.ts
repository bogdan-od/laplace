import { Controller, Get } from '@nestjs/common';
import type { ReviewItem } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ReviewService } from './review.service';

@Controller('api/review')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get()
  inbox(@CurrentUser() user: AuthUser): ReviewItem[] {
    return this.review.inbox(user);
  }
}
