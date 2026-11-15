import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { LoginBody, PatchMeBody, RegisterBody, Role } from '@shared/api';
import { LOGIN_RE, MAX_NAME_CHARS, MIN_PASSWORD_CHARS } from '@shared/limits';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Trim, TrimLower, TrimUpper } from '../common/dto-transforms';

// Not in shared/limits: only the server needs it, to bound the scrypt input.
const MAX_PASSWORD_CHARS = 200;
const MAX_INVITE_INPUT_CHARS = 64;
const LOGIN_MESSAGE =
  'логін - 3-32 символи: малі латинські літери, цифри та . _ -';

export class LoginDto implements LoginBody {
  @ApiProperty()
  @TrimLower()
  @IsString()
  @IsNotEmpty()
  login!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PASSWORD_CHARS)
  password!: string;
}

export class RegisterDto implements RegisterBody {
  @ApiProperty({ description: 'Lower case; matches LOGIN_RE' })
  @TrimLower()
  @IsString()
  @Matches(LOGIN_RE, { message: LOGIN_MESSAGE })
  login!: string;

  @ApiProperty({ minLength: MIN_PASSWORD_CHARS })
  @IsString()
  @MinLength(MIN_PASSWORD_CHARS)
  @MaxLength(MAX_PASSWORD_CHARS)
  password!: string;

  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_NAME_CHARS)
  name!: string;

  @ApiProperty({ enum: ['teacher', 'student'] })
  @IsIn(['teacher', 'student'])
  role!: Role;

  @ApiPropertyOptional({ description: 'Required for a student' })
  @IsOptional()
  @TrimUpper()
  @IsString()
  @MaxLength(MAX_INVITE_INPUT_CHARS)
  invite_code?: string;
}

export class PasswordChangeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PASSWORD_CHARS)
  old!: string;

  @ApiProperty({ minLength: MIN_PASSWORD_CHARS })
  @IsString()
  @MinLength(MIN_PASSWORD_CHARS)
  @MaxLength(MAX_PASSWORD_CHARS)
  new!: string;
}

export class PatchMeDto implements PatchMeBody {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_NAME_CHARS)
  name?: string;

  @ApiPropertyOptional({ type: PasswordChangeDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PasswordChangeDto)
  password?: PasswordChangeDto;
}
