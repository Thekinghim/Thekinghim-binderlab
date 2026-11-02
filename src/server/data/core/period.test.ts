import { describe, expect, it } from "vitest";

import { isoDateToShellDate, resolveAppPeriod, scopeFromSearchParams } from "./period";

// Måndag 2 nov. 2026 00:30 svensk tid = söndag 1 nov. 23:30 UTC.
const NOW = new Date("2026-11-01T23:30:00Z");
const TZ = "Europe/Stockholm";
const opts = { timeZone: TZ, dataStart: "2026-10-13", now: NOW };

describe("resolveAppPeriod", () => {
  it("standard är 30 dagar t.o.m. i dag i organisationens tidszon, med lika lång jämförelse", () => {
    const p = resolveAppPeriod({}, opts);
    expect(p.key).toBe("30d");
    expect(p.period).toEqual({ start: "2026-10-04", end: "2026-11-02" });
    expect(p.compare).toEqual({ start: "2026-09-04", end: "2026-10-03" });
    expect(p.days).toBe(30);
  });

  it("'Allt' går från första dagen med data och saknar jämförelse", () => {
    const p = resolveAppPeriod({ period: "allt" }, opts);
    expect(p.period).toEqual({ start: "2026-10-13", end: "2026-11-02" });
    expect(p.compare).toBeNull();
    expect(p.days).toBe(21);
    expect(p.dataStart).toBe("2026-10-13");
  });

  it("'Allt' utan data blir bara i dag", () => {
    const p = resolveAppPeriod({ period: "allt" }, { ...opts, dataStart: null });
    expect(p.period).toEqual({ start: "2026-11-02", end: "2026-11-02" });
    expect(p.compare).toBeNull();
  });

  it("'Denna månad' jämförs med samma dagar förra månaden", () => {
    const p = resolveAppPeriod({ period: "manad" }, opts);
    expect(p.period).toEqual({ start: "2026-11-01", end: "2026-11-02" });
    expect(p.compare).toEqual({ start: "2026-10-01", end: "2026-10-02" });
  });

  it("eget intervall, omvänt och in i framtiden, rättas och kapas vid i dag", () => {
    const p = resolveAppPeriod({ from: "2026-12-01", to: "2026-10-20" }, opts);
    expect(p.key).toBe("eget");
    expect(p.period).toEqual({ start: "2026-10-20", end: "2026-11-02" });
    expect(p.compare).toEqual({ start: "2026-10-06", end: "2026-10-19" });
  });

  it("tål skräp i URL:en", () => {
    const p = resolveAppPeriod(
      new URLSearchParams("period=foo&from=2026-02-30&butik=x&automat="),
      opts,
    );
    expect(p.key).toBe("30d");
    expect(p.scope).toEqual({ storeId: null, machineId: null });
  });
});

describe("scopeFromSearchParams", () => {
  it("tar bara uuid:n, i gemener", () => {
    expect(
      scopeFromSearchParams({
        butik: "8B9903C2-D902-432E-B6E4-DB346DE6689B",
        automat: "'; drop table orders; --",
      }),
    ).toEqual({ storeId: "8b9903c2-d902-432e-b6e4-db346de6689b", machineId: null });
  });
});

describe("isoDateToShellDate", () => {
  it("ger mitt på dagen så att kalenderdagen är densamma i alla tidszoner", () => {
    const d = isoDateToShellDate("2026-10-13");
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 13, 12]);
  });
});
