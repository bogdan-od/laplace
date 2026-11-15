import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { ApiError } from '@shared/api';
import type { Request, Response } from 'express';
import { ApiException } from './api-exception';
import { isLargeBodyRoute } from './large-bodies';

const SERVER_ERROR_TEXT = 'Помилка сервера';

const FALLBACK_TEXT: Record<number, string> = {
  400: 'Некоректний запит',
  401: 'Потрібно увійти',
  403: 'Недостатньо прав',
  404: 'Не знайдено',
  405: 'Метод не підтримується',
  409: 'Конфлікт',
  413: 'Тіло запиту завелике',
  415: 'Непідтримуваний тип даних',
  429: 'Забагато запитів',
};

const BODY_PARSER_TEXT: Record<string, { status: number; message: string }> = {
  'entity.parse.failed': {
    status: 400,
    message: 'Некоректний JSON у тілі запиту',
  },
  'entity.too.large': { status: 413, message: 'Тіло запиту завелике' },
  'encoding.unsupported': { status: 415, message: 'Непідтримуване кодування' },
};

function fallbackText(status: number): string {
  if (status >= 500) return SERVER_ERROR_TEXT;
  return FALLBACK_TEXT[status] ?? 'Помилка запиту';
}

function bodyParserError(
  exception: unknown,
): { status: number; message: string } | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const type: unknown = (exception as { type?: unknown }).type;
  return typeof type === 'string' ? BODY_PARSER_TEXT[type] : undefined;
}

/** A request that carried a journal: its 413 means `journal_too_large`, which clients handle specially. */
export interface RequestRoute {
  method: string;
  path: string;
}

export function toApiError(exception: unknown, route?: RequestRoute): ApiError {
  if (exception instanceof ApiException) {
    const body: ApiError = {
      statusCode: exception.getStatus(),
      message: exception.message,
      ...exception.extra,
    };
    if (exception.code) body.code = exception.code;
    return body;
  }
  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    return { statusCode, message: fallbackText(statusCode) };
  }
  const parsed = bodyParserError(exception);
  if (parsed) {
    const body: ApiError = {
      statusCode: parsed.status,
      message: parsed.message,
    };
    if (
      parsed.status === 413 &&
      route &&
      isLargeBodyRoute(route.method, route.path)
    ) {
      body.code = 'journal_too_large';
    }
    return body;
  }
  return { statusCode: 500, message: SERVER_ERROR_TEXT };
}

/** Every 4xx/5xx response gets the shape of ApiError; 500 details go to the log only. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const body = toApiError(exception, { method: req.method, path: req.path });
    if (body.statusCode >= 500) {
      const detail =
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : 'non-error exception';
      this.logger.error(detail);
    }
    if (res.headersSent) return;
    res.status(body.statusCode).json(body);
  }
}
