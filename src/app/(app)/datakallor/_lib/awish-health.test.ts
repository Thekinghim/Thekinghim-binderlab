import { describe, expect, it } from "vitest";

import type { AwishPathFacts } from "@/analytics/watch";

import { awishHealthRow, awishHealthRows, awishHealthSummary } from "./awish-health";

const NOW = new Date("2026-11-24T12:00:00Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const when = (iso: string) => iso.slice(11, 16);

const row = (over: Partial<AwishPathFacts> = {}): AwishPathFacts => ({
  sourceId: "s1",
  path: "stock",
  activeRoute: "open_api",
  lastSuccessAt: ago(3),
  lastSuccessRoute: "open_api",
  lastAttemptAt: ago(3),
  lastErrorAt: null,
  lastErrorKind: null,
  lastErrorCode: null,
  failingSince: null,
  breakerRoute: null,
  breakerOpenUntil: null,
  fallbackSince: null,
  ...over,
});

describe("Om Awish krånglar", () => {
  it("fungerar", () => {
    expect(awishHealthRow(row(), when)).toMatchObject({
      label: "Lager i automaterna",
      state: "ok",
      text: "Fungerar · 11:57",
      error: null,
    });
  });

  it("reservväg med Open API:s fel (13 = Awish internt fel)", () => {
    expect(
      awishHealthRow(
        row({
          activeRoute: "webbpanelen",
          lastErrorAt: ago(3),
          lastErrorKind: "server",
          lastErrorCode: 13,
          fallbackSince: ago(9 * 60),
        }),
        when,
      ),
    ).toMatchObject({
      state: "fallback",
      text: "Reservväg: webbpanelen sedan 03:00",
      error: "Senaste fel 11:57: Awish internt fel (13)",
    });
  });

  it("senast kända för order, lager och automater; annars fungerar inte", () => {
    const failing = {
      lastSuccessAt: ago(40),
      failingSince: ago(35),
      activeRoute: "senast_kanda" as const,
    };
    expect(awishHealthRow(row({ path: "orders", ...failing }), when)).toMatchObject({
      state: "stale",
      text: "Senast kända 11:20",
    });
    expect(
      awishHealthRow(row({ path: "push", ...failing, activeRoute: "ingen" }), when),
    ).toMatchObject({
      state: "broken",
      text: "Fungerar inte sedan 11:25",
    });
  });

  it("webbpanelen är den vanliga vägen för påfyllningar: ingen reservväg", () => {
    expect(awishHealthRow(row({ path: "push", activeRoute: "webbpanelen" }), when).state).toBe(
      "ok",
    );
  });

  it("ordning, oprovade vägar döljs, sammanfattning", () => {
    const rows = awishHealthRows(
      [
        row({ path: "merchant" }),
        row({ path: "stock", activeRoute: "webbpanelen" }),
        row({ path: "orders" }),
        row({ path: "campaigns", lastAttemptAt: null, lastSuccessAt: null }),
      ],
      when,
    );
    expect(rows.map((r) => r.path)).toEqual(["orders", "stock", "merchant"]);
    expect(awishHealthSummary(rows)).toEqual({ tone: "warn", text: "Reservvägen används" });
    expect(awishHealthSummary([])).toEqual({ tone: "ok", text: "Allt fungerar" });
  });
});
