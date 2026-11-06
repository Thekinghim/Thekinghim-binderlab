import { describe, expect, it } from "vitest";

import {
  AUTO_REFRESH_MS,
  autoRefreshDue,
  clockLabel,
  lastAwishRead,
  refreshNotice,
} from "./refresh";

const TZ = "Europe/Stockholm";
// 2026-11-06 14:52 i Stockholm (UTC+1).
const NOW = "2026-11-06T13:52:00Z";

describe("clockLabel", () => {
  it("klockslag i dag i organisationens tidszon", () => {
    expect(clockLabel("2026-11-06T13:47:30Z", NOW, TZ)).toBe("14:47");
    expect(clockLabel("2026-11-06T13:47:30Z", NOW, "UTC")).toBe("13:47");
  });
  it("igår och äldre", () => {
    expect(clockLabel("2026-11-05T21:05:00Z", NOW, TZ)).toBe("igår 22:05");
    // Midnatt i Stockholm är 23:00 UTC: samma UTC-dag men i går i Stockholm.
    expect(clockLabel("2026-11-05T22:59:00Z", "2026-11-05T23:01:00Z", TZ)).toBe("igår 23:59");
    expect(clockLabel("2026-11-01T09:00:00Z", NOW, TZ)).toMatch(/^1\s?nov.*10:00$/);
  });
});

describe("lastAwishRead", () => {
  it("den senaste läsningen, null utan någon", () => {
    expect(lastAwishRead([])).toBeNull();
    expect(lastAwishRead([{ syncedAt: null }])).toBeNull();
    expect(
      lastAwishRead([
        { syncedAt: "2026-11-06T13:40:00.000Z" },
        { syncedAt: null },
        { syncedAt: "2026-11-06T13:50:00.000Z" },
        { syncedAt: "2026-11-06T13:45:00.000Z" },
      ]),
    ).toBe("2026-11-06T13:50:00.000Z");
  });
});

describe("autoRefreshDue (högst var 30:e sekund)", () => {
  it("spärrar inom 30 s, släpper efter", () => {
    const t = 1_000_000;
    expect(AUTO_REFRESH_MS).toBe(30_000);
    expect(autoRefreshDue(t, t + 1_000)).toBe(false);
    expect(autoRefreshDue(t, t + 29_999)).toBe(false);
    expect(autoRefreshDue(t, t + 30_000)).toBe(true);
    expect(autoRefreshDue(0, t)).toBe(true);
  });
  it("en tidpunkt i framtiden (klockan ändrad) spärrar inte", () => {
    expect(autoRefreshDue(2_000_000, 1_000_000)).toBe(true);
  });
});

describe("refreshNotice", () => {
  const ctx = { now: NOW, lastReadAt: "2026-11-06T13:47:00Z", timeZone: TZ };
  it("lyckad läsning, spärr, pågående synk och ingen Awish: Uppdaterat", () => {
    for (const status of ["read", "throttled", "busy", "none", "demo"] as const) {
      expect(refreshNotice({ ok: true, status, lastReadAt: "2026-11-06T13:52:00Z" }, ctx)).toEqual({
        text: "Uppdaterat 14:52",
        tone: "ok",
      });
    }
  });
  it("delvis läst", () => {
    expect(refreshNotice({ ok: true, status: "partial", lastReadAt: null }, ctx)).toEqual({
      text: "Uppdaterat 14:52 · några automater svarade inte",
      tone: "warn",
    });
  });
  it("Awish svarar inte: lugnt fel med senaste läsningen", () => {
    expect(
      refreshNotice({ ok: true, status: "failed", lastReadAt: "2026-11-06T13:47:00Z" }, ctx),
    ).toEqual({ text: "Kunde inte nå Awish – visar senaste läsningen 14:47", tone: "warn" });
    expect(refreshNotice({ ok: false, offline: false }, ctx).text).toBe(
      "Kunde inte nå Awish – visar senaste läsningen 14:47",
    );
    expect(refreshNotice({ ok: false, offline: true }, ctx).text).toBe(
      "Utan nät – visar senaste läsningen 14:47",
    );
    expect(refreshNotice({ ok: false, offline: false }, { ...ctx, lastReadAt: null }).text).toBe(
      "Kunde inte nå Awish",
    );
  });
});
