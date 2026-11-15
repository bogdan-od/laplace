import { Injectable, PipeTransform } from '@nestjs/common';

/** Invite codes are typed by hand: case and surrounding spaces do not matter. */
@Injectable()
export class TrimUpperPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    return value.trim().toUpperCase();
  }
}
