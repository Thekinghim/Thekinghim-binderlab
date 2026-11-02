import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const captureException = vi.fn((_error: unknown, _context?: unknown) => "evt-exception");
const captureMessage = vi.fn((_message: string, _context?: unknown) => "evt-message");
const flush = vi.fn(async (_timeout?: number) => true);
vi.mock("@sentry/nextjs", () => ({ captureException, captureMessage, flush }));

const { captureToSentry, sentryEnabled } = await import("./sentry");
const { clip, errorText } = await import("./system-alerts");

const event = {
  message: "Import misslyckades: fel",
  tags: { area: "import", kind: "import_failed", organization_id: "org" },
  extra: { file_sha256: "abc" },
  fingerprint: ["import_failed", "källa"],
};

describe("captureToSentry", () => {
  const before = process.env.SENTRY_DSN;
  beforeEach(() => {
    captureException.mockClear();
    captureMessage.mockClear();
    flush.mockClear();
  });
  afterEach(() => {
    if (before === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = before;
  });

  it("skickar inget utan SENTRY_DSN", async () => {
    delete process.env.SENTRY_DSN;
    expect(sentryEnabled()).toBe(false);
    expect(await captureToSentry({ ...event, error: new Error("x") })).toBeNull();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("skickar felet med taggar och fingeravtryck när DSN finns", async () => {
    process.env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/1";
    const error = new Error("Lagringen svarar inte");
    expect(await captureToSentry({ ...event, error })).toBe("evt-exception");
    expect(captureException).toHaveBeenCalledWith(error, {
      level: "error",
      tags: event.tags,
      extra: { file_sha256: "abc", beskrivning: event.message },
      fingerprint: event.fingerprint,
    });
  });

  it("väntar på att händelsen skickas (serverlöst) och tvättar bort e-postadresser", async () => {
    process.env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/1";
    await captureToSentry({
      ...event,
      error: null,
      message: "Rapportutskick misslyckades: butik@example.se studsade",
      extra: { detalj: "till anna@example.se", antal: 1 },
    });
    expect(captureMessage).toHaveBeenCalledWith(
      "Rapportutskick misslyckades: [e-post] studsade",
      expect.objectContaining({
        extra: {
          detalj: "till [e-post]",
          antal: 1,
          beskrivning: "Rapportutskick misslyckades: [e-post] studsade",
        },
      }),
    );
    expect(flush).toHaveBeenCalledWith(2_000);
  });

  it("utan felobjekt skickas ett meddelande", async () => {
    process.env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/1";
    expect(await captureToSentry({ ...event, error: null })).toBe("evt-message");
    expect(captureMessage).toHaveBeenCalledWith(event.message, expect.any(Object));
  });

  it("kastar aldrig, även om Sentry gör det", async () => {
    process.env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/1";
    captureException.mockImplementationOnce(() => {
      throw new Error("SDK trasig");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await captureToSentry({ ...event, error: new Error("x") })).toBeNull();
    spy.mockRestore();
  });
});

describe("texter till larmet", () => {
  it("felmeddelandet blir en kort rad utan stackspår", () => {
    expect(errorText(new Error("rad 1\n  rad 2"))).toBe("rad 1 rad 2");
    expect(errorText("x".repeat(400)).length).toBe(300);
    expect(errorText({ okänt: true })).toBe("Okänt fel");
    expect(clip("  a   b  ", 10)).toBe("a b");
    const wrapped = new Error('Failed query: insert into "alert_runs" … params: org,2026-11-02', {
      cause: new Error("anslutningen bröts"),
    });
    expect(errorText(wrapped)).toBe("Databasfel: anslutningen bröts");
  });
});

describe("beforeSend tvättar ett fångat fel", () => {
  it("e-postadresser i felets text och i extra försvinner", async () => {
    const { sentryOptions } = await import("@/server/observability/sentry-options");
    const options = sentryOptions({
      dsn: "https://key@o0.ingest.sentry.io/1",
      environment: "test",
    });
    const sent = options.beforeSend({
      message: "Rapportutskick misslyckades",
      exception: { values: [{ type: "Error", value: "550 butik@example.se finns inte" }] },
      extra: { beskrivning: "till anna@example.se" },
      user: { id: "u1", email: "agare@example.se" },
    });
    expect(JSON.stringify(sent)).not.toMatch(/@example\.se/);
    expect(sent.exception.values[0]!.value).toBe("550 [e-post] finns inte");
    expect(sent.user).toEqual({ id: "u1" });
  });
});
