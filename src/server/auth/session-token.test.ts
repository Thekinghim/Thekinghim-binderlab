import { SignJWT, UnsecuredJWT } from "jose";
import { describe, expect, it } from "vitest";

import { DEV_SESSION_TTL_SECONDS, signDevSession, verifyDevSession } from "./session-token";

const SECRET = "a".repeat(48);
const OTHER = "b".repeat(48);
const session = { userId: "11111111-2222-4333-8444-555555555555", email: "anna@example.se" };
const T0 = new Date("2026-11-02T12:00:00Z");

describe("sessions-JWT (dev)", () => {
  it("signerar och verifierar", async () => {
    const token = await signDevSession(session, SECRET, { now: T0 });
    expect(await verifyDevSession(token, SECRET, { now: T0 })).toEqual({ ok: true, session });
    const [header] = token.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toMatchObject({
      alg: "HS256",
    });
  });

  it("nekar en utgången session", async () => {
    const token = await signDevSession(session, SECRET, { now: T0 });
    const later = new Date(T0.getTime() + (DEV_SESSION_TTL_SECONDS + 1) * 1000);
    expect(await verifyDevSession(token, SECRET, { now: later })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("nekar fel signatur och manipulerat innehåll", async () => {
    const token = await signDevSession(session, SECRET, { now: T0 });
    expect(await verifyDevSession(token, OTHER, { now: T0 })).toEqual({
      ok: false,
      reason: "invalid",
    });
    const [h, , s] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "99999999-2222-4333-8444-555555555555", email: "x@y.se" }),
    ).toString("base64url");
    expect((await verifyDevSession(`${h}.${forged}.${s}`, SECRET, { now: T0 })).ok).toBe(false);
  });

  it("nekar alg=none, fel issuer och fel audience", async () => {
    const none = new UnsecuredJWT({ email: session.email })
      .setSubject(session.userId)
      .setIssuer("binderlab-dev")
      .setAudience("binderlab")
      .setIssuedAt()
      .setExpirationTime("1h")
      .encode();
    expect((await verifyDevSession(none, SECRET)).ok).toBe(false);

    const key = new TextEncoder().encode(SECRET);
    const sign = (iss: string, aud: string) =>
      new SignJWT({ email: session.email })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(session.userId)
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(key);
    expect((await verifyDevSession(await sign("annan", "binderlab"), SECRET)).ok).toBe(false);
    expect((await verifyDevSession(await sign("binderlab-dev", "authenticated"), SECRET)).ok).toBe(
      false,
    );
    expect((await verifyDevSession(await sign("binderlab-dev", "binderlab"), SECRET)).ok).toBe(
      true,
    );
  });

  it("nekar skräp och kräver uuid och långt nog hemligt värde", async () => {
    expect((await verifyDevSession("inte.en.jwt", SECRET)).ok).toBe(false);
    await expect(signDevSession({ ...session, userId: "x" }, SECRET)).rejects.toThrow(/uuid/);
    await expect(signDevSession(session, "kort")).rejects.toThrow(/32 tecken/);
  });
});
