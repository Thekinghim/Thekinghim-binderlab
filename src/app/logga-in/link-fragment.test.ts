import { describe, expect, it } from "vitest";

import { parseLinkFragment, unverifiedEmail } from "./link-fragment";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "ES256" })}.${b64(payload)}.signatur`;
}

describe("parseLinkFragment", () => {
  it("läser sessionen från Supabases standardmall (implicit flöde)", () => {
    const access = jwt({ email: "åsa@exempel.se", sub: "x" });
    const hash = `#access_token=${access}&expires_at=1&expires_in=3600&refresh_token=abc&token_type=bearer&type=magiclink`;
    expect(parseLinkFragment(hash)).toEqual({
      kind: "tokens",
      accessToken: access,
      refreshToken: "abc",
      type: "magiclink",
      email: "åsa@exempel.se",
    });
  });

  it("fel i fragmentet eller frågesträngen", () => {
    expect(
      parseLinkFragment("#error=access_denied&error_code=otp_expired&error_description=x"),
    ).toEqual({ kind: "error", code: "otp_expired" });
    expect(parseLinkFragment("", "?error=access_denied")).toEqual({
      kind: "error",
      code: "access_denied",
    });
  });

  it("inget att läsa: tomt, bara access_token eller annat", () => {
    expect(parseLinkFragment("")).toEqual({ kind: "none" });
    expect(parseLinkFragment("#access_token=a.b.c")).toEqual({ kind: "none" });
    expect(parseLinkFragment("#kontoplan")).toEqual({ kind: "none" });
  });
});

describe("unverifiedEmail", () => {
  it("tål trasiga token", () => {
    expect(unverifiedEmail("inte-en-jwt")).toBeNull();
    expect(unverifiedEmail("a.%%%.c")).toBeNull();
    expect(unverifiedEmail(jwt({ sub: "x" }))).toBeNull();
  });
});
