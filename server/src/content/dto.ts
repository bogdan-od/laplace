import { ApiProperty } from '@nestjs/swagger';
import type { CheckCommand, Hint, JournalRole } from '@shared/api';
import {
  MAX_COMMAND_CHARS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
} from '@shared/limits';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Highest hint penalty: a grade is at most 100 (assignments.max_grade). */
export const MAX_HINT_PENALTY = 100;

export class CheckCommandDto implements CheckCommand {
  @ApiProperty({ description: 'Machine id from the topology' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TITLE_CHARS)
  node!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TITLE_CHARS)
  title!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COMMAND_CHARS)
  command!: string;
}

export class HintDto implements Hint {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TEXT_CHARS)
  text!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(MAX_HINT_PENALTY)
  penalty!: number;
}

export class JournalRoleQueryDto {
  @ApiProperty({ enum: ['start', 'reference'] })
  @IsIn(['start', 'reference'])
  role!: JournalRole;
}
