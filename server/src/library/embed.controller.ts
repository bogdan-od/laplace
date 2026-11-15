import { Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { EmbedService } from './embed.service';

@Controller('api/embed')
export class EmbedController {
  constructor(private readonly embeds: EmbedService) {}

  /** Public: whoever holds the token sees the journal the author chose to publish. */
  @Public()
  @Get(':token')
  @Header('Cache-Control', 'no-store')
  payload(@Param('token') token: string): StreamableFile {
    return this.embeds.payload(token);
  }
}
