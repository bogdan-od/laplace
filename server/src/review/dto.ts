import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CommentBody, GradeBody } from '@shared/api';
import { MAX_TEXT_CHARS } from '@shared/limits';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Trim } from '../common/dto-transforms';

const MAX_NODE_CHARS = 100;
const MAX_QUERY_CHARS = 100;

export class GradeDto implements GradeBody {
  @ApiProperty({ description: 'Integer from 0 to the assignment max_grade' })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  grade!: number;

  @ApiPropertyOptional({
    description: 'Overall note; when omitted the previous one stays',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_TEXT_CHARS)
  note?: string;
}

export class CommentDto implements CommentBody {
  @ApiProperty({ description: 'Machine id from the topology' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_NODE_CHARS)
  node!: string;

  @ApiProperty({ description: 'Player position: the number of events played' })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  event_index!: number;

  @ApiProperty({ description: 'Guest time in ms to seek to' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  vtime_ms!: number;

  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TEXT_CHARS)
  text!: string;
}

export class SearchQueryDto {
  @ApiProperty({
    description: 'At least 2 characters; shorter gives an empty result',
  })
  @IsString()
  @MaxLength(MAX_QUERY_CHARS)
  q!: string;
}

export class ActivityQueryDto {
  @ApiPropertyOptional({ description: 'Only entries older than this id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  before?: number;
}
