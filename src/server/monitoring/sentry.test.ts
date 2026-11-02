import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const captureException = vi.fn((_error: unknown, _context?: unknown) => "evt-exception");
const captureMessage = vi.fn((_message: string, _context?: unknown) => "evt-message");
vi.mock("@sentry/nextjs", () => ({ captureException, captureMessage }));

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
  });
});
