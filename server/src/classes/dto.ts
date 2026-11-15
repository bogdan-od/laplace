import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  AddAssistantBody,
  CreateClassBody,
  ImportCsvBody,
  PatchClassBody,
} from '@shared/api';
import { MAX_CSV_CHARS, MAX_TITLE_CHARS } from '@shared/limits';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim, TrimLower } from '../common/dto-transforms';

export class CreateClassDto implements CreateClassBody {
  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TITLE_CHARS)
  name!: string;

  @ApiProperty({ description: 'May be an empty string' })
  @Trim()
  @IsString()
  @MaxLength(MAX_TITLE_CHARS)
  subject!: string;
}

export class PatchClassDto implements PatchClassBody {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TITLE_CHARS)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(MAX_TITLE_CHARS)
  subject?: string;
}

export class ImportCsvDto implements ImportCsvBody {
  @ApiProperty({ description: 'Lines "name" or "name;login"' })
  @IsString()
  @MaxLength(MAX_CSV_CHARS)
  csv!: string;
}

export class AddAssistantDto implements AddAssistantBody {
  @ApiProperty()
  @TrimLower()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TITLE_CHARS)
  login!: string;
}
