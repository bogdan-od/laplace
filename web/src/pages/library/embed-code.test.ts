import { describe, expect, it } from "vitest";
import { embedAddress, iframeCode } from "./embed-code";

describe("embed code", () => {
  it("builds the address from the origin and the token", () => {
    expect(embedAddress("abc123", "http://localhost:5173")).toBe("http://localhost:5173/embed/abc123");
  });
  it("is an iframe of 960 x 640", () => {
    expect(iframeCode("https://x.test/embed/t")).toBe('<iframe src="https://x.test/embed/t" width="960" height="640"></iframe>');
  });
});
