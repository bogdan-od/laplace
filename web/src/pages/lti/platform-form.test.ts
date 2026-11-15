import { describe, expect, it } from "vitest";
import type { CreateLtiPlatformBody } from "@shared/api";
import { checkPlatform, EMPTY_PLATFORM, platformFormValid, trimmed } from "./platform-form";

const FILLED: CreateLtiPlatformBody = {
  name: "Moodle університету",
  issuer: "https://moodle.example.org",
  client_id: "abc123",
  deployment_id: "1",
  auth_login_url: "https://moodle.example.org/mod/lti/auth.php",
  token_url: "https://moodle.example.org/mod/lti/token.php",
  jwks_url: "https://moodle.example.org/mod/lti/certs.php",
};

describe("checkPlatform", () => {
  it("asks for every one of the seven fields", () => {
    const errors = checkPlatform(EMPTY_PLATFORM);
    expect(Object.keys(errors).sort()).toEqual(Object.keys(EMPTY_PLATFORM).sort());
    expect(errors.client_id).toBe("Заповніть це поле");
  });

  it("treats spaces only as empty", () => {
    expect(checkPlatform({ ...FILLED, deployment_id: "   " }).deployment_id).toBe("Заповніть це поле");
  });

  it("accepts a filled form", () => {
    expect(checkPlatform(FILLED)).toEqual({});
    expect(platformFormValid(FILLED)).toBe(true);
  });

  it("refuses http and malformed addresses, only in the three address fields", () => {
    const errors = checkPlatform({
      ...FILLED,
      issuer: "http://moodle.example.org",
      auth_login_url: "http://moodle.example.org/auth",
      token_url: "moodle.example.org/token",
      jwks_url: "https://user:pass@moodle.example.org/certs",
    });
    expect(errors.issuer).toBeUndefined();
    expect(errors.auth_login_url).toBe("Адреса має починатися з https://");
    expect(errors.token_url).toBe("Адреса має починатися з https://");
    expect(errors.jwks_url).toBe("Адреса має починатися з https://");
    expect(platformFormValid({ ...FILLED, jwks_url: "http://x.example/certs" })).toBe(false);
  });
});

describe("trimmed", () => {
  it("cuts the spaces around every value", () => {
    expect(trimmed({ ...FILLED, name: "  Moodle  ", client_id: " abc123 " })).toEqual({ ...FILLED, name: "Moodle" });
  });
});
