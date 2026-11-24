import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { issueConfirmToken, verifyConfirmToken, CONFIRM_TOKEN_TTL_S } =
  await import("./confirm-token");

const subject = {
  orgId: "o",
  userId: "u",
  machineId: "m",
  action: "REBOOT",
  idempotencyKey: "k",
};
const env = { CRON_SECRET: "hemligt" };
const NOW = 1_800_000_000_000;

describe("bekräftelsebevis för Starta om / Stäng av", () => {
  it("gäller samma användare, automat, kommando och nyckel i 10 minuter", () => {
    const t = issueConfirmToken(subject, NOW, env);
    expect(verifyConfirmToken(t, subject, NOW, env)).toBe(true);
    expect(verifyConfirmToken(t, subject, NOW + CONFIRM_TOKEN_TTL_S * 1000, env)).toBe(true);
    expect(verifyConfirmToken(t, subject, NOW + (CONFIRM_TOKEN_TTL_S + 1) * 1000, env)).toBe(false);
    for (const k of Object.keys(subject) as Array<keyof typeof subject>) {
      expect(verifyConfirmToken(t, { ...subject, [k]: "annan" }, NOW, env)).toBe(false);
    }
    expect(verifyConfirmToken(t, subject, NOW, { CRON_SECRET: "annat" })).toBe(false);
    expect(verifyConfirmToken("x", subject, NOW, env)).toBe(false);
    expect(verifyConfirmToken(undefined, subject, NOW, env)).toBe(false);
  });

  it("utan hemlighet i miljön: en nyckel per process (fungerar i samma process)", () => {
    const t = issueConfirmToken(subject, NOW, {});
    expect(verifyConfirmToken(t, subject, NOW, {})).toBe(true);
  });
});
