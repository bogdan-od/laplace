import { ApiProperty } from '@nestjs/swagger';
import type { CreateLtiPlatformBody } from '@shared/api';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Trim } from '../common/dto-transforms';

const MAX_FIELD_CHARS = 500;

export class CreatePlatformDto implements CreateLtiPlatformBody {
  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FIELD_CHARS)
  name!: string;

  @ApiProperty({
    description: 'The platform issuer (iss) exactly as it sends it',
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FIELD_CHARS)
  issuer!: string;

  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FIELD_CHARS)
  client_id!: string;

  @ApiProperty()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FIELD_CHARS)
  deployment_id!: string;

  @ApiProperty({
    description: 'https only (http with LAPLACE_LTI_ALLOW_HTTP=1)',
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FIELD_CHARS)
  auth_login_url!: string;

  @ApiProperty({
    description: 'https only (http with LAPLACE_LTI_ALLOW_HTTP=1)',
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FIELD_CHARS)
  token_url!: string;

  @ApiProperty({
    description: 'https only (http with LAPLACE_LTI_ALLOW_HTTP=1)',
  })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_FIELD_CHARS)
  jwks_url!: string;
}
