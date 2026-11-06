/**
 * Awish-synkens takt: pg_cron var femte minut. Tidsgränserna måste passa intervallet så
 * att körningar aldrig överlappar (låset och funktionens maxDuration är kortare än fem
 * minuter) och saldot läses i varje tick (stock.test.ts, stockDue).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { LEASE_MS, TIME_BUDGET_MS } = await import("./sync");
const { STOCK_DUE_MARGIN_MS, STOCK_SYNC_INTERVAL_MS } = await import("./stock");
const { CRON_JOBS } = await import("@/server/monitoring/cron-monitor");

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const TICK_MS = 5 * 60_000;

function routeMaxDurationMs(): number {
  const text = readFileSync(root("src/app/api/cron/awish/route.ts"), "utf8");
  const m = /export const maxDuration = (\d+);/.exec(text);
  if (!m) throw new Error("maxDuration saknas i /api/cron/awish");
  return Number(m[1]) * 1000;
}

describe("Awish-synkens takt (var femte minut)", () => {
  it("migreringen och Sentry-bevakningen har samma schema", () => {
    const sql = readFileSync(
      root("supabase/migrations/20261112000000_awish_synk_var_femte_minut.sql"),
      "utf8",
    );
    expect(sql).toContain(
      "cron.schedule('binderlab-awish-sync', '*/5 * * * *', 'select private.awish_cron_tick()')",
    );
    expect(CRON_JOBS.awish.schedule).toBe("*/5 * * * *");
    expect(CRON_JOBS.awish.maxRuntimeMinutes * 60_000).toBeLessThan(TICK_MS);
  });

  it("en körning och låset är kortare än intervallet: körningar överlappar aldrig", () => {
    const maxDuration = routeMaxDurationMs();
    expect(TIME_BUDGET_MS).toBeLessThan(maxDuration);
    // Låset håller hela körningen och är släppt till nästa tick om körningen dör.
    expect(LEASE_MS).toBeGreaterThan(maxDuration);
    expect(LEASE_MS).toBeLessThan(TICK_MS);
  });

  it("saldot läses i varje tick", () => {
    expect(STOCK_SYNC_INTERVAL_MS).toBe(TICK_MS);
    // Gränsen (intervall − marginal) ligger under intervallet minus en hel körning,
    // och över noll med god marginal (ingen dubbelläsning strax efter en annan körning).
    expect(STOCK_SYNC_INTERVAL_MS - STOCK_DUE_MARGIN_MS).toBeLessThan(
      TICK_MS - routeMaxDurationMs() - 30_000,
    );
    expect(STOCK_SYNC_INTERVAL_MS - STOCK_DUE_MARGIN_MS).toBeGreaterThanOrEqual(2 * 60_000);
  });
});
