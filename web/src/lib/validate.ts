// Client-side checks of form fields with the limits from the contract. The server checks the same
// again; the point here is that a form with a wrong field is never sent.

import { LOGIN_RE, MAX_NAME_CHARS, MAX_TITLE_CHARS, MIN_PASSWORD_CHARS } from "@shared/limits";

export const LOGIN_HINT = "Логін - 3-32 символи: малі латинські літери, цифри та . _ -";

export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function checkLogin(login: string): string | undefined {
  const value = normalizeLogin(login);
  if (value === "") return "Введіть логін";
  return LOGIN_RE.test(value) ? undefined : LOGIN_HINT;
}

export function checkNewPassword(password: string): string | undefined {
  if (password === "") return "Введіть пароль";
  if (password.length < MIN_PASSWORD_CHARS) return `Пароль - щонайменше ${MIN_PASSWORD_CHARS} символів`;
  return undefined;
}

export function checkPersonName(name: string): string | undefined {
  const value = name.trim();
  if (value === "") return "Введіть ім'я";
  return value.length > MAX_NAME_CHARS ? `Ім'я - не більше ${MAX_NAME_CHARS} символів` : undefined;
}

export function checkTitle(title: string, what: string): string | undefined {
  const value = title.trim();
  if (value === "") return `Введіть ${what}`;
  return value.length > MAX_TITLE_CHARS ? `Не більше ${MAX_TITLE_CHARS} символів` : undefined;
}

const FIELD_PREFIX = /^Поле ([\w.]+): (.*)$/s;

/** The server names the first bad field in its 400 text: "Поле login: має неприпустимий формат". */
export function splitFieldMessage(message: string): { field: string; text: string } | null {
  const match = FIELD_PREFIX.exec(message);
  if (!match) return null;
  const [, field, text] = match;
  return field === undefined || text === undefined ? null : { field, text };
}

export type FieldErrors<K extends string> = Partial<Record<K | "form", string>>;

export function hasErrors(errors: object): boolean {
  return Object.values(errors).some((value) => value !== undefined);
}
