import { ApiProperty } from '@nestjs/swagger';
import type { ReadNotificationsBody } from '@shared/api';
import { IsInt, Max, Min } from 'class-validator';

export class ReadNotificationsDto implements ReadNotificationsBody {
  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  up_to!: number;
}
