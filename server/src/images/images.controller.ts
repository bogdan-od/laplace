import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { FILES_PREFIX } from '../static-files';

@Controller('api/images')
export class ImagesController {
  @Public()
  @Get()
  get(): { root: string } {
    return { root: FILES_PREFIX };
  }
}
