import { describe, expect, it } from "vitest";

import { REDACTED, scrubEvent, sentryOptions } from "./sentry-options";

describe("Sentry-inställningar", () => {
  it("skickar aldrig personuppgifter som standard och har låg sampling", () => {
    const options = sentryOptions({
      dsn: "https://k@o1.ingest.sentry.io/1",
      environment: "production",
    });
    expect(options.sendDefaultPii).toBe(false);
    expect(options.environment).toBe("production");
    expect(options.tracesSampleRate).toBeLessThanOrEqual(0.1);
  });

  it("tar bort e-post, cookies, Authorization och inbjudningstoken", () => {
    const token = "a".repeat(64);
    const event = {
      message: "Inloggning misslyckades för anna.svensson@example.se",
      user: { id: "u1", email: "anna@example.se", ip_address: "1.2.3.4" },
      request: {
        url: `https://app.binderlab.se/inbjudan/${token}?token_hash=abc&type=invite`,
        cookies: { bl_session: "hemligt" },
        data: { password: "hemligt" },
        headers: { cookie: "bl_session=hemligt", Authorization: "Bearer x", "user-agent": "UA" },
      },
      breadcrumbs: [{ message: "POST till kalle@firma.se" }],
      extra: { nested: { deeper: ["mejla lisa@example.com"] } },
    };
    const scrubbed = scrubEvent(event);
    const text = JSON.stringify(scrubbed);
    expect(text).not.toMatch(/@example|@firma/);
    expect(text).not.toContain("hemligt");
    expect(text).not.toContain(token);
    expect(text).not.toContain("Bearer");
    expect(scrubbed.user).toEqual({ id: "u1" });
    expect(scrubbed.request.headers.cookie).toBe(REDACTED);
    expect(scrubbed.request.headers["user-agent"]).toBe("UA");
    expect(scrubbed.request.url).toBe(
      `https://app.binderlab.se/inbjudan/[token]?token_hash=${REDACTED}&type=invite`,
    );
    // Originalet ändras inte.
    expect(event.user.email).toBe("anna@example.se");
  });

  it("beforeSend och beforeBreadcrumb tvättar", () => {
    const options = sentryOptions({
      dsn: "https://k@o1.ingest.sentry.io/1",
      environment: "preview",
    });
    expect(options.beforeSend({ message: "x@y.se" })).toEqual({ message: "[e-post]" });
    expect(options.beforeBreadcrumb({ message: "x@y.se" })).toEqual({ message: "[e-post]" });
  });
});
