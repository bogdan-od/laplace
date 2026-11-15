import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  AppendEventsBody,
  BranchKind,
  CreateBranchBody,
  HelpBody,
  JournalEvent,
  JournalHeader,
  ReplyBody,
  SubmitBody,
} from '@shared/api';
import { MAX_TEXT_CHARS } from '@shared/limits';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Trim } from '../common/dto-transforms';

const BRANCH_KINDS: BranchKind[] = ['start', 'rollback', 'continue', 'reply'];
/** Machines in a topology are few; this only bounds the size of a submission body. */
const MAX_SUBMIT_HEADS = 64;
const MAX_NODE_CHARS = 100;
/** Upper bound of events in one journal (JOURNAL_LIMITS.max_events), so a chunk cannot be larger. */
const MAX_EVENTS_PER_CHUNK = 500_000;

export class BranchParentDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  branch_id!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  event!: number;
}

export class CreateBranchDto implements CreateBranchBody {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_NODE_CHARS)
  node!: string;

  @ApiProperty({ nullable: true, type: BranchParentDto })
  @ValidateIf((_dto, value) => value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => BranchParentDto)
  parent!: BranchParentDto | null;

  @ApiProperty({ enum: BRANCH_KINDS })
  @IsIn(BRANCH_KINDS)
  kind!: BranchKind;

  @ApiProperty({
    description: 'Checked by check_journal_strict with no events',
  })
  @IsObject()
  header!: JournalHeader;

  @ApiProperty()
  @IsBoolean()
  make_head!: boolean;
}

export class ChunkMetaDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
  commands!: number;

  @ApiProperty()
  @IsString()
  last_command!: string;
}

export class AppendEventsDto implements AppendEventsBody {
  @ApiProperty()
  @IsInt()
  @Min(0)
  from!: number;

  @ApiProperty({ description: 'Checked by check_journal_strict' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EVENTS_PER_CHUNK)
  events!: JournalEvent[];

  @ApiPropertyOptional({ type: ChunkMetaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ChunkMetaDto)
  meta?: ChunkMetaDto;
}

export class JournalQueryDto {
  @ApiPropertyOptional({ description: 'Cut the journal to its first N events' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  to?: number;
}

export class SetHeadDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_NODE_CHARS)
  node!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  branch_id!: number;
}

export class HelpDto implements HelpBody {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_NODE_CHARS)
  node!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  branch_id!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  event_count!: number;

  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TEXT_CHARS)
  text!: string;
}

export class HelpQueryDto {
  @ApiPropertyOptional({ enum: ['1'] })
  @IsOptional()
  @IsIn(['1'])
  open?: '1';
}

export class ReplyDto implements ReplyBody {
  @ApiProperty()
  @IsInt()
  @Min(1)
  branch_id!: number;
}

export class SubmitHeadDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_NODE_CHARS)
  node!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  branch_id!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  event_count!: number;
}

export class SubmitDto implements SubmitBody {
  @ApiProperty({ type: [SubmitHeadDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SUBMIT_HEADS)
  @ValidateNested({ each: true })
  @Type(() => SubmitHeadDto)
  heads!: SubmitHeadDto[];
}
