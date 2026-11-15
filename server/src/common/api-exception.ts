import { HttpException } from '@nestjs/common';
import type { ApiErrorCode } from '@shared/api';

/**
 * An error whose message is already written for the user (Ukrainian). The exception filter passes
 * the message through; for every other exception it substitutes a generic text.
 */
export class ApiException extends HttpException {
  readonly code: ApiErrorCode | undefined;
  /** Extra fields merged into the response body (for example event_count of chunk_gap). */
  readonly extra: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code?: ApiErrorCode,
    extra: Record<string, unknown> = {},
  ) {
    super(message, status);
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (
  message: string,
  code?: ApiErrorCode,
): ApiException => new ApiException(400, message, code);
export const notLoggedIn = (): ApiException =>
  new ApiException(401, 'Потрібно увійти', 'not_logged_in');
export const forbidden = (message: string): ApiException =>
  new ApiException(403, message);
export const notFound = (message: string): ApiException =>
  new ApiException(404, message);
export const conflict = (message: string, code?: ApiErrorCode): ApiException =>
  new ApiException(409, message, code);
