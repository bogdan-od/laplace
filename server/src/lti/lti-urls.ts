import type { LtiToolInfo } from '@shared/api';
import { parsePort } from '../port';

/** Base of the absolute addresses the platform needs: LAPLACE_PUBLIC_URL, else the local address. */
export function publicBase(): string {
  const configured = process.env.LAPLACE_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `http://localhost:${parsePort(process.env.PORT)}`;
}

/** https only; plain http is for tests and a local LMS and must be enabled on purpose. */
export function isAllowedPlatformUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && process.env.LAPLACE_LTI_ALLOW_HTTP === '1';
}

/** The three addresses the platform needs, built from the public base. */
export function toolUrls(): LtiToolInfo {
  const base = publicBase();
  return {
    login_url: `${base}/api/lti/login`,
    launch_url: `${base}/api/lti/launch`,
    jwks_url: `${base}/api/lti/jwks`,
  };
}
