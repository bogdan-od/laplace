import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  AssignBody,
  ClipBody,
  CreateItemBody,
  ItemKind,
  LessonFromSubmissionBody,
  PatchItemBody,
  Topology,
} from '@shared/api';
import {
  MAX_BRIEF_CHARS,
  MAX_CHECKS,
  MAX_HINTS,
  MAX_TITLE_CHARS,
} from '@shared/limits';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MAX_GRADE_LIMIT } from '../assignments/dto';
import { Trim } from '../common/dto-transforms';
import { CheckCommandDto, HintDto } from '../content/dto';

const KINDS: ItemKind[] = ['task', 'lesson', 'clip'];

export class CreateItemDto implements CreateItemBody {
  @ApiProperty({ enum: KINDS })
  @IsIn(KINDS)
  kind!: ItemKind;

  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TITLE_CHARS)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_BRIEF_CHARS)
  brief?: string;

  @ApiProperty({ description: 'v86-topology/1; checked by validate_topology' })
  @IsObject()
  topology!: Topology;
}

export class PatchItemDto implements PatchItemBody {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  topology?: Topology;

  @ApiPropertyOptional({ type: [CheckCommandDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CHECKS)
  @ValidateNested({ each: true })
  @Type(() => CheckCommandDto)
  checks?: CheckCommandDto[];

  @ApiPropertyOptional({ type: [HintDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_HINTS)
  @ValidateNested({ each: true })
  @Type(() => HintDto)
  hints?: HintDto[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  clip_from_ms?: number | null;
}

export class AssignDto implements AssignBody {
  @ApiProperty()
  @IsInt()
  @Min(1)
  class_id!: number;

  @ApiProperty({ nullable: true })
  @ValidateIf((_dto, value) => value !== null)
  @IsInt()
  @Min(0)
  due_at!: number | null;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(MAX_GRADE_LIMIT)
  max_grade!: number;

  @ApiProperty()
  @IsBoolean()
  shared_lan!: boolean;
}

export class LessonFromSubmissionDto implements LessonFromSubmissionBody {
  @ApiProperty()
  @IsInt()
  @Min(1)
  submission_id!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TITLE_CHARS)
  node!: string;
}

export class ClipDto implements ClipBody {
  @ApiProperty()
  @IsInt()
  @Min(1)
  branch_id!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  to_event!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  from_ms!: number;

  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TITLE_CHARS)
  title!: string;
}
