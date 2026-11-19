import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mailCanSend, MAIL_OFF_TEXT } = await import("./can-send");
const { dispatchDelivery } = await import("@/server/notify");
const { sendDeps, REPORT_MAIL_OFF } = await import("@/server/reports/runtime");

describe("kan appen skicka e-post?", () => {
  it("produktionen i dag: ingen leverantör vald på Vercel → nej", () => {
    expect(mailCanSend({ VERCEL: "1" })).toBe(false);
    expect(mailCanSend({ VERCEL: "1", MAIL_PROVIDER: "outbox" })).toBe(false);
  });

  it("resend utan nyckel eller avsändare → nej; inställt → ja", () => {
    expect(mailCanSend({ MAIL_PROVIDER: "resend" })).toBe(false);
    expect(mailCanSend({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" })).toBe(false);
    expect(
      mailCanSend({
        VERCEL: "1",
        MAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_x",
        MAIL_FROM: "Binderlab <rapport@example.se>",
      }),
    ).toBe(true);
  });

  it("utkorgen lokalt (utveckling och tester) → ja", () => {
    expect(mailCanSend({})).toBe(true);
    expect(mailCanSend({ MAIL_PROVIDER: "outbox" })).toBe(true);
  });
});

const delivery = {
  userId: "u1",
  sendAt: "2026-11-19T12:00:00.000Z",
  deferred: false,
  subject: "BL-004 är offline",
  items: [],
};

describe("utan e-postleverantör", () => {
  it("ett larm till e-post görs inget försök med och står aldrig som skickat", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("MAIL_PROVIDER", "");
    try {
      const r = await dispatchDelivery(
        delivery,
        {
          userId: "u1",
          email: "agare@example.se",
          phone: null,
          channels: ["email"],
          pushDevices: [],
        },
        { baseUrl: "https://app.example.se", timeZone: "Europe/Stockholm", organizationName: "X" },
      );
      expect(r.results).toEqual([{ channel: "email", status: "skipped", detail: MAIL_OFF_TEXT }]);
      expect(r.status).toBe("skipped");
      expect(MAIL_OFF_TEXT).toBe("E-post är inte påslagen");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("en rapport går inte att mejla: felet säger att den delas med Dela", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("MAIL_PROVIDER", "");
    try {
      await expect(sendDeps("Binderlab")).rejects.toThrow(REPORT_MAIL_OFF);
      expect(REPORT_MAIL_OFF).toBe("E-post är inte påslagen. Dela rapporten själv med Dela.");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
