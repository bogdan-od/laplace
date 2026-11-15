import { Controller, Get, Query } from '@nestjs/common';
import type { SearchResult } from '@shared/api';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { SearchQueryDto } from './dto';
import { SearchService } from './search.service';

@Controller('api/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  find(
    @CurrentUser() user: AuthUser,
    @Query() query: SearchQueryDto,
  ): SearchResult {
    return this.search.search(user, query.q);
  }
}
