import type { CreateLtiPlatformBody } from "@shared/api";
import { hasErrors, type FieldErrors } from "@/lib/validate";

export type PlatformField = keyof CreateLtiPlatformBody;

export const PLATFORM_FIELDS: readonly { key: PlatformField; label: string; url: boolean }[] = [
  { key: "name", label: "Назва (для вас)", url: false },
  { key: "issuer", label: "Ідентифікатор платформи (issuer)", url: false },
  { key: "client_id", label: "Client ID", url: false },
  { key: "deployment_id", label: "Deployment ID", url: false },
  { key: "auth_login_url", label: "Адреса автентифікації", url: true },
  { key: "token_url", label: "Адреса видачі токенів", url: true },
  { key: "jwks_url", label: "Адреса набору ключів платформи", url: true },
];

export const EMPTY_PLATFORM: CreateLtiPlatformBody = {
  name: "",
  issuer: "",
  client_id: "",
  deployment_id: "",
  auth_login_url: "",
  token_url: "",
  jwks_url: "",
};

const HTTPS_ONLY = "Адреса має починатися з https://";

function checkUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? undefined : HTTPS_ONLY;
  } catch {
    return HTTPS_ONLY;
  }
}

/** Every field is required; the three addresses must be https. The server checks the same again. */
export function checkPlatform(values: CreateLtiPlatformBody): FieldErrors<PlatformField> {
  const errors: FieldErrors<PlatformField> = {};
  for (const { key, url } of PLATFORM_FIELDS) {
    const value = values[key].trim();
    if (value === "") errors[key] = "Заповніть це поле";
    else if (url) errors[key] = checkUrl(value);
  }
  return errors;
}

export const platformFormValid = (values: CreateLtiPlatformBody): boolean => !hasErrors(checkPlatform(values));

export function trimmed(values: CreateLtiPlatformBody): CreateLtiPlatformBody {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])) as unknown as CreateLtiPlatformBody;
}
