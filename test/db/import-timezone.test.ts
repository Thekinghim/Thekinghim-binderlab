/**
 * Tidszoner i importen. Källans tid (Payment Time) tolkas i datakällans
 * tidszon (Awish: Asia/Shanghai), sparas i UTC, och affärsdatumet räknas i
 * organisationens tidszon (Europe/Stockholm). Körs under TZ=UTC,
 * Europe/Stockholm och Asia/Shanghai med samma resultat.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { businessDateOf } from "../../src/import/zoned";
import { db, rows } from "./helpers";
import { awishCsv, ordersOf, setupImportOrg } from "./import-fixtures";

describe("tidszon i importen", () => {
  it("order 42780: 2026-11-02 00:17:00 i Shanghai = 2026-11-01T16:17:00Z = 1 nov. 17:17 svensk tid", async () => {
    const f = await setupImportOrg({ sourceTimezone: "Asia/Shanghai" });
    const file = awishCsv([{ no: "42780", time: "2026-11-02 00:17:00" }]);

    const preview = await f.run(file, { dryRun: true });
    expect(preview.firstRow).toMatchObject({
      sourceLocal: "2026-11-02 00:17:00",
      utc: "2026-11-01T16:17:00.000Z",
      organizationLocal: "2026-11-01 17:17:00",
      businessDate: "2026-11-01",
    });

    await f.run(file);
    const [order] = await ordersOf(f.orgId);
    expect(order?.ordered_at).toBe("2026-11-01T16:17:00Z");
    expect(order?.business_date).toBe("2026-11-01");
    // Samma sak sedd från databasen i svensk tid.
    const [sv] = await rows<{ local: string }>(
      db(),
      sql`select to_char(ordered_at at time zone 'Europe/Stockholm', 'YYYY-MM-DD HH24:MI') as local
          from public.orders where organization_id = ${f.orgId}`,
    );
    expect(sv?.local).toBe("2026-11-01 17:17");
  });

  it("sommartidsveckan (25 okt. 2026): Shanghai-tider ger rätt svenskt affärsdatum kring dubbeltimmen", async () => {
    const f = await setupImportOrg({ sourceTimezone: "Asia/Shanghai" });
    // [källans tid i Shanghai, UTC, svensk tid, affärsdatum]
    const cases = [
      ["2026-10-24 23:59:59", "2026-10-24T15:59:59Z", "2026-10-24"], // 17:59:59 CEST
      ["2026-10-25 05:59:59", "2026-10-24T21:59:59Z", "2026-10-24"], // 23:59:59 CEST
      ["2026-10-25 06:00:00", "2026-10-24T22:00:00Z", "2026-10-25"], // 00:00 CEST
      ["2026-10-25 08:30:00", "2026-10-25T00:30:00Z", "2026-10-25"], // 02:30 CEST (första)
      ["2026-10-25 09:30:00", "2026-10-25T01:30:00Z", "2026-10-25"], // 02:30 CET (andra)
      ["2026-10-26 06:59:59", "2026-10-25T22:59:59Z", "2026-10-25"], // 23:59:59 CET
      ["2026-10-26 07:00:00", "2026-10-25T23:00:00Z", "2026-10-26"], // 00:00 CET
      ["2026-10-31 12:00:00", "2026-10-31T04:00:00Z", "2026-10-31"],
    ] as const;
    const r = await f.run(awishCsv(cases.map(([time], i) => ({ no: `W${i}`, time }))));
    expect(r.summary).toMatchObject({ new: cases.length, error: 0 });
    // Shanghai har ingen sommartid: inga tvetydiga tider.
    expect(r.warnings.map((w) => w.code)).not.toContain("ambiguous_time");

    const orders = await ordersOf(f.orgId);
    expect(orders.map((o) => [o.ordered_at, o.business_date])).toEqual(
      cases.map(([, utc, date]) => [utc, date]),
    );
    // Förhandsvisningens affärsdatum (Intl) och databasens (at time zone) är samma.
    for (const o of orders) {
      expect(businessDateOf(new Date(o.ordered_at), "Europe/Stockholm")).toBe(o.business_date);
    }
  });

  it("källa i Stockholm: dubbeltimmen 02:30 blir den tidigaste tidpunkten och loggas", async () => {
    const f = await setupImportOrg({ sourceTimezone: "Europe/Stockholm" });
    const r = await f.run(
      awishCsv([
        { no: "D1", time: "2026-10-25 01:59:59" },
        { no: "D2", time: "2026-10-25 02:30:00" },
        { no: "D3", time: "2026-10-25 03:00:00" },
        { no: "D4", time: "2026-03-29 02:30:00" },
      ]),
    );
    expect(r.summary).toMatchObject({ new: 4, error: 0 });
    expect(r.warnings.find((w) => w.code === "ambiguous_time")?.rows).toEqual([3]);
    expect(r.warnings.find((w) => w.code === "nonexistent_time")?.rows).toEqual([5]);

    const orders = await ordersOf(f.orgId);
    expect(orders.map((o) => [o.external_id, o.ordered_at, o.business_date])).toEqual([
      ["D1", "2026-10-24T23:59:59Z", "2026-10-25"],
      ["D2", "2026-10-25T00:30:00Z", "2026-10-25"],
      ["D3", "2026-10-25T02:00:00Z", "2026-10-25"],
      ["D4", "2026-03-29T01:30:00Z", "2026-03-29"],
    ]);
    const log = await rows<{ row_number: number; message: string | null }>(
      db(),
      sql`select row_number, message from public.import_rows
          where import_id = ${r.importId} order by row_number`,
    );
    expect(log.find((l) => l.row_number === 3)?.message).toContain("tidigaste");
    expect(log.find((l) => l.row_number === 5)?.message).toContain("flyttades fram");
    expect(log.find((l) => l.row_number === 2)?.message).toBeNull();
  });
});
