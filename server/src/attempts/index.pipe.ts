import { Injectable, PipeTransform } from '@nestjs/common';
import { notFound } from '../common/api-exception';

/** Path parameter that is a zero-based position (a hint index); anything else names nothing. */
@Injectable()
export class IndexPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!/^(0|[1-9]\d{0,8})$/.test(value))
      throw notFound('Підказку не знайдено');
    return Number(value);
  }
}
