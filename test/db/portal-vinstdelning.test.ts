/**
 * Butiksportalen visar butiksrapporter med vinstdelning
 * (20261218000300_portal_vinstdelning.sql).
 *
 * En rapport med vinstdelning har butikens summor för inköp och vinst i ersättningsdelen
 * (report.compensation.splits). Portalen stoppade förut varje sådan rapport. Nu gäller samma
 * regel som assertStoreReportSafe i appen: nycklarna får stå i ersättningsdelen när den har
 * vinstdelning, ingen annanstans, och allt annat stoppas som förut.
 *
 * Mot riktig Postgres:
 * 1. Funktionen private.portal_snapshot_safe med rapporter byggda för hand.
 * 2. En godkänd rapport med vinstdelning når butikens egen användare via portal_report, och
 *    inte någon annan butik.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { queryPortalReport } from "@/server/portal/queries";

import { asPostgres, asUser, one, settle } from "./helpers";
import { seedPortalFixture, type PortalFixture } from "./portal-fixture";

let f: PortalFixture;

beforeAll(async () => {
  f = await seedPortalFixture();
});

/** En butiksrapport med vinstdelning för butiken, som den sparas. */
function splitReport(storeId: string, over: Record<string, unknown> = {}) {
  return {
    kind: "store",
    store: { id: storeId, name: "ICA Testbutik" },
    sales: { revenueOre: 64_700, orders: 3 },
    compensation: {
      model: "profit_split",
      totalOre: 9_400,
      splits: [
        {
          validFrom: "2025-03-01",
          range: { start: "2025-03-01", end: "2025-03-31" },
          orders: 3,
          salesInclVatOre: 64_700,
          purchasesOre: 42_500,
          cardFeesOre: 1_400,
          profitOre: 20_800,
          storeShareOre: 10_400,
          operatorShareOre: 10_400,
          evidence: { scope: { storeId } },
        },
      ],
      steps: [{ kind: "share", amountOre: 10_400, evidence: { scope: { storeId } } }],
    },
    ...over,
  };
}

const safe = (report: unknown, storeId: string) =>
  asPostgres(async (tx) =>
    one<{ ok: boolean }>(
      tx,
      sql`select private.portal_snapshot_safe(${JSON.stringify(report)}::jsonb, ${storeId}::uuid) as ok`,
    ),
  ).then((r) => r.ok);

describe("portal_snapshot_safe", () => {
  it("vinstdelning: inköp och vinst får stå i ersättningsdelen", async () => {
    expect(await safe(splitReport(f.a.storeId), f.a.storeId)).toBe(true);
  });

  it("samma nycklar utanför ersättningsdelen stoppas", async () => {
    for (const leak of [
      { profitOre: 1 },
      { sales: { revenueOre: 1, purchasesOre: 2 } },
      { machines: [{ name: "BL-001", marginBp: 3_000 }] },
      { basis: { payer: { name: "X AB" }, costOre: 5 } },
    ])
      expect(await safe(splitReport(f.a.storeId, leak), f.a.storeId), JSON.stringify(leak)).toBe(
        false,
      );
  });

  it("utan vinstdelning gäller samma regel som förut, också i ersättningsdelen", async () => {
    const report = splitReport(f.a.storeId);
    const none = {
      ...report,
      compensation: { ...report.compensation, splits: [], profitOre: 5 },
    };
    expect(await safe(none, f.a.storeId)).toBe(false);
    const missing = { ...report, compensation: { totalOre: 100, profitOre: 5 } };
    expect(await safe(missing, f.a.storeId)).toBe(false);
    // En vanlig rapport utan något sådant går igenom som förut.
    expect(
      await safe({ ...report, compensation: { totalOre: 100, splits: [] } }, f.a.storeId),
    ).toBe(true);
  });

  it("i ersättningsdelen stoppas fortfarande andra butiker, listor och fel typ", async () => {
    const report = splitReport(f.a.storeId);
    const withKey = (extra: Record<string, unknown>) => ({
      ...report,
      compensation: { ...report.compensation, ...extra },
    });
    for (const bad of [
      withKey({ evidence: { scope: { storeId: f.a2.storeId } } }),
      withKey({ stores: [{ id: f.a2.storeId }] }),
      withKey({ prices: [] }),
      withKey({ agreements: [] }),
      withKey({ placements: [] }),
      withKey({ settings: {} }),
      withKey({ investments: [] }),
      withKey({ detail: { orders: [{ id: "o-1" }] } }),
    ])
      expect(await safe(bad, f.a.storeId), JSON.stringify(bad.compensation).slice(0, 80)).toBe(
        false,
      );
    // Rapporten för en annan butik.
    expect(await safe(report, f.a2.storeId)).toBe(false);
  });
});

describe("portal_report med vinstdelning", () => {
  let id: string;

  beforeAll(async () => {
    id = await asPostgres(async (tx) => {
      const row = await one<{ id: string }>(
        tx,
        sql`insert into public.reports (organization_id, kind, period_start, period_end, store_id,
                                        storage_path, data_snapshot, calc_version)
            values (${f.a.orgId}, 'store_statement', '2025-02-01', '2025-02-28', ${f.a.storeId},
                    ${`${f.a.orgId}/reports/butik-vinst-2025-02.pdf`},
                    ${JSON.stringify({ type: "butik", report: splitReport(f.a.storeId) })}::jsonb,
                    'calc@1')
            returning id`,
      );
      await tx.execute(
        sql`insert into public.report_approvals (organization_id, report_id)
            values (${f.a.orgId}, ${row.id})`,
      );
      return row.id;
    });
  });

  it("butikens egen användare får rapporten med uträkningen", async () => {
    const res = await asUser(f.storeA1, (tx) => queryPortalReport(tx, f.a.storeId, id));
    const report = res.report as { compensation?: { splits?: { profitOre: number }[] } } | null;
    expect(report?.compensation?.splits?.[0]?.profitOre).toBe(20_800);
  });

  it("en annan butiks användare når den inte", async () => {
    for (const [u, storeId] of [
      [f.storeA2, f.a.storeId],
      [f.storeA2, f.a2.storeId],
      [f.storeB1, f.b.storeId],
    ] as const) {
      const outcome = await settle(asUser(u, (tx) => queryPortalReport(tx, storeId, id)));
      expect(outcome.ok).toBe(false);
    }
  });
});
