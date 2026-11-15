import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { badRequest } from './api-exception';

const HAS_CYRILLIC = /[Ѐ-ӿ]/;
const FIRST_NUMBER = /-?\d+/;

/**
 * class-validator names a failed rule and writes its message in English. A rule declared with its
 * own Ukrainian `message` passes through unchanged; for the rest the text is built here.
 * Numbers (limits) are taken from the English message: class-validator keeps them only there.
 */
function constraintText(name: string, englishMessage: string): string {
  if (HAS_CYRILLIC.test(englishMessage)) return englishMessage;
  const limit = FIRST_NUMBER.exec(englishMessage)?.[0] ?? '';
  switch (name) {
    case 'isString':
      return 'має бути рядком';
    case 'isNotEmpty':
      return 'не може бути порожнім';
    case 'minLength':
      return `має містити щонайменше ${limit} символів`;
    case 'maxLength':
      return `має містити не більше ${limit} символів`;
    case 'matches':
      return 'має неприпустимий формат';
    case 'isIn':
      return 'має неприпустиме значення';
    case 'isInt':
      return 'має бути цілим числом';
    case 'isNumber':
      return 'має бути числом';
    case 'isBoolean':
      return 'має бути логічним значенням';
    case 'min':
      return `не може бути меншим за ${limit}`;
    case 'max':
      return `не може бути більшим за ${limit}`;
    case 'isArray':
      return 'має бути масивом';
    case 'arrayMaxSize':
      return `може містити не більше ${limit} елементів`;
    case 'isObject':
    case 'nestedValidation':
      return 'має бути об’єктом';
    case 'whitelistValidation':
      return 'не передбачено';
    default:
      return 'має неприпустиме значення';
  }
}

function firstLeaf(
  errors: ValidationError[],
  path: string,
): { path: string; text: string } | undefined {
  for (const error of errors) {
    const here = path ? `${path}.${error.property}` : error.property;
    const [name, message] = Object.entries(error.constraints ?? {})[0] ?? [];
    if (name !== undefined && message !== undefined) {
      return { path: here, text: constraintText(name, message) };
    }
    const nested = firstLeaf(error.children ?? [], here);
    if (nested) return nested;
  }
  return undefined;
}

/** One Ukrainian sentence for the first failed field: "Поле login: має бути рядком". */
export function validationMessage(errors: ValidationError[]): string {
  const leaf = firstLeaf(errors, '');
  if (!leaf) return 'Некоректний запит';
  return `Поле ${leaf.path}: ${leaf.text}`;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => badRequest(validationMessage(errors)),
  });
}
