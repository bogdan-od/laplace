import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { PatchAssignmentBody } from '@shared/api';
import { MAX_BRIEF_CHARS, MAX_CHECKS, MAX_TITLE_CHARS } from '@shared/limits';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Trim } from '../common/dto-transforms';
import { CheckCommandDto } from '../content/dto';

export const MAX_GRADE_LIMIT = 100;

export class PatchAssignmentDto implements PatchAssignmentBody {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TITLE_CHARS)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_BRIEF_CHARS)
  brief?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'null clears the due date',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  due_at?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_GRADE_LIMIT)
  max_grade?: number;

  @ApiPropertyOptional({ type: [CheckCommandDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CHECKS)
  @ValidateNested({ each: true })
  @Type(() => CheckCommandDto)
  checks?: CheckCommandDto[];
}

export class CalendarQueryDto {
  @ApiProperty({ description: 'ms since the epoch, inclusive' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  from!: number;

  @ApiProperty({ description: 'ms since the epoch, exclusive' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  to!: number;
}
