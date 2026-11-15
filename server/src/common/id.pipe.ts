import { Injectable, PipeTransform } from '@nestjs/common';
import { notFound } from './api-exception';

/** Path parameter that must be a positive integer; anything else cannot name an object. */
@Injectable()
export class IdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!/^[1-9]\d{0,14}$/.test(value)) throw notFound('Не знайдено');
    return Number(value);
  }
}
