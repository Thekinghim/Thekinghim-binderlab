/**
 * Utvärderingen 4 nov, punkt 1: Butiksportal och Hem sa "Betala 12 930 kr" för oktober
 * medan rapporten och bokföringen sa 8 193 kr, eftersom avräkningens belopp räknades en
 * gång och sparades. Nu:
 *
 * - en obetald avräkning visar alltid beloppet som gäller nu (Butiksportal, Att göra/Hem,
 *   dokumentet), samma som butikens andel i bokföringen,
 * - "markera som betald" räknar om och låser det nya beloppet, vägrar ett gammalt belopp
 *   och vägrar när avräkningen inte kan räknas (saknat inköpspris),
 * - en betald avräkning ändras aldrig,
 * - sidan skapar inget när den öppnas (jobbet eller knappen gör det),
 * - jobbet sparar det nya beloppet på obetalda (det butiken ser i portalen).
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { setTestPurchaseFor } from "@/app/(app)/order/_lib/service";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import { loadTodosFor, type Viewer } from "@/server/data/core/loaders";
import { buildSnapshot } from "@/server/reports/snapshot";
import { loadSnapshotInput } from "@/server/reports/sources";
import {
  createMonthlySettlements,
  ensureSettlementsFor,
  loadSettlementPageFor,
  markSettlementPaidFor,
  settlementDocumentFor,
  SettlementError,
} from "@/server/settlements/service";

import { asPostgres, asUser, db, one, rows, type TestUser } from "./helpers";
import { seedPortalTenant, type PortalTenant } from "./portal-fixture";

// Fixturens order ligger i mars 2025; den 3 april avräknas mars.
const APRIL = new Date("2025-04-03T08:00:00Z");
/** Ett gammalt sparat belopp (som 12 930 kr i produktionen). */
const STALE = 1_293_000;

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

async function rejects(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

/** Butikens andel för mars i bokföringsunderlaget (samma uträkning som rapporten). */
async function bookShare(t: PortalTenant): Promise<number> {
  const snap = await asPostgres(async (tx) =>
    buildSnapshot(
      await loadSnapshotInput(tx, {
        organizationId: t.orgId,
        type: "bokforing",
        month: "2025-03",
        now: APRIL.toISOString(),
      }),
    ),
  );
  if (snap.type !== "bokforing") throw new Error("fel typ");
  return snap.report.stores.find((x) => x.storeId === t.storeId)!.compensationOre;
}

async function stored(t: PortalTenant) {
  return asPostgres((tx) =>
    one<{ id: string; amount_ore: string; paid_on: string | null }>(
      tx,
      sql`select id, amount_ore, paid_on::text as paid_on
          from public.store_settlements where organization_id = ${t.orgId}`,
    ),
  );
}

/** Som om beloppet räknades innan inköpspriserna eller avtalet rättades. */
async function makeStale(id: string) {
  await asPostgres((tx) =>
    tx.execute(sql`update public.store_settlements set amount_ore = ${STALE} where id = ${id}`),
  );
}

describe("sidan läser bara", () => {
  let t: PortalTenant;
  let owner: Viewer;
  beforeAll(async () => {
    t = await seedPortalTenant("Sega gubben Läs");
    owner = await viewerFor(t.owner, t.orgId);
  });

  it("öppna Butiksportal skapar ingen avräkning; den visas som saknad med en knapp", async () => {
    const page = await loadSettlementPageFor(owner, APRIL);
    expect(page.rows).toEqual([]);
    expect(page.missing).toEqual([{ storeId: t.storeId, storeName: "Sega gubben Läs" }]);
    const n = await asPostgres((tx) =>
      rows(tx, sql`select id from public.store_settlements where organization_id = ${t.orgId}`),
    );
    expect(n).toHaveLength(0);

    const run = await ensureSettlementsFor(owner, APRIL);
    expect(run).toMatchObject({ created: 1, errors: [] });
    const after = await loadSettlementPageFor(owner, APRIL);
    expect(after.missing).toEqual([]);
    expect(after.rows).toHaveLength(1);
  });
});

describe("obetald: beloppet som gäller nu", () => {
  let t: PortalTenant;
  let owner: Viewer;
  let id: string;
  let share: number;
  beforeAll(async () => {
    t = await seedPortalTenant("Sega gubben Nu");
    owner = await viewerFor(t.owner, t.orgId);
    await ensureSettlementsFor(owner, APRIL);
    id = (await stored(t)).id;
    share = await bookShare(t);
    await makeStale(id);
  });

  it("Butiksportal visar samma belopp som bokföringen, inte det sparade", async () => {
    const page = await loadSettlementPageFor(owner, APRIL);
    const row = page.rows.find((r) => r.id === id)!;
    expect(share).toBeGreaterThan(0);
    expect(row.amountOre).toBe(share);
    expect(row.storedAmountOre).toBe(STALE);
    expect(row.blocked).toBeNull();
    // Att läsa sparar inget.
    expect(Number((await stored(t)).amount_ore)).toBe(STALE);
  });

  it("Att göra (Hem) säger det nya beloppet", async () => {
    const todos = await loadTodosFor(owner, APRIL);
    const todo = todos.find((x) => x.kind === "settlement")!;
    expect(todo.fingerprint).toBe(`1|${share}`);
    expect(todo.title).not.toContain("12");
  });

  it("dokumentet (PDF/HTML) visar det nya beloppet", async () => {
    const doc = await settlementDocumentFor(owner, id, APRIL);
    expect(doc.html).not.toContain("12 930");
    expect(doc.html).toContain(String(Math.floor(share / 100)));
  });

  it("betala med det gamla beloppet vägras; med det nya låses det nya", async () => {
    const err = await rejects(markSettlementPaidFor(owner, id, "2025-04-03", STALE, APRIL));
    expect(err).toBeInstanceOf(SettlementError);
    expect((err as Error).message).toContain("Beloppet har ändrats");
    expect((await stored(t)).paid_on).toBeNull();

    const res = await markSettlementPaidFor(owner, id, "2025-04-03", share, APRIL);
    expect(res.amountOre).toBe(share);
    const row = await stored(t);
    expect(row.paid_on).toBe("2025-04-03");
    expect(Number(row.amount_ore)).toBe(share);
  });

  it("en betald avräkning ändras inte när underlaget ändras", async () => {
    const [order] = await asPostgres((tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from public.orders where organization_id = ${t.orgId} and external_id = '42002'`,
      ),
    );
    await setTestPurchaseFor(owner, order!.id, true);
    const page = await loadSettlementPageFor(owner, APRIL);
    expect(page.rows.find((r) => r.id === id)!.amountOre).toBe(share);
    await setTestPurchaseFor(owner, order!.id, false);
  });
});

describe("obetald följer testköp direkt", () => {
  it("ett testköp sänker beloppet utan Räkna om", async () => {
    const t = await seedPortalTenant("Sega gubben Testköp");
    const owner = await viewerFor(t.owner, t.orgId);
    await ensureSettlementsFor(owner, APRIL);
    const before = (await loadSettlementPageFor(owner, APRIL)).rows[0]!.amountOre;
    const [order] = await asPostgres((tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from public.orders where organization_id = ${t.orgId} and external_id = '42002'`,
      ),
    );
    await setTestPurchaseFor(owner, order!.id, true);
    const after = (await loadSettlementPageFor(owner, APRIL)).rows[0]!.amountOre;
    expect(after).toBeLessThan(before);
    expect(after).toBe(await bookShare(t));
  });
});

describe("spärrad när avräkningen inte kan räknas", () => {
  let t: PortalTenant;
  let owner: Viewer;
  let id: string;
  beforeAll(async () => {
    t = await seedPortalTenant("Sega gubben Spärr");
    owner = await viewerFor(t.owner, t.orgId);
    await ensureSettlementsFor(owner, APRIL);
    id = (await stored(t)).id;
    // Vinstdelning från mars och en order vars titel saknar inköpspris.
    await asUser(t.owner, async (tx) => {
      await tx.execute(
        sql`update public.store_agreements set valid_to = '2025-02-28' where store_id = ${t.storeId}`,
      );
      await tx.execute(sql`insert into public.store_agreements
          (organization_id, store_id, valid_from, commission_base, commission_bp, loss_treatment)
        values (${t.orgId}, ${t.storeId}, '2025-03-01', 'profit_after_costs', 5000, 'zero')`);
    });
    await asPostgres(async (tx) => {
      const title = await one<{ id: string }>(
        tx,
        sql`insert into public.titles (organization_id, name)
            values (${t.orgId}, 'Utan inköpspris') returning id`,
      );
      await tx.execute(
        sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                       ordered_at, amount_ore, machine_id, source_hash)
            values (${t.orgId}, ${t.dataSourceId}, '42009', 'Utan pris', ${title.id},
                    '2025-03-20T10:00:00Z', 9900, ${t.machineId}, 'h9')`,
      );
    });
  });

  it("raden är spärrad, ingår inte i summan och kan inte markeras som betald", async () => {
    const page = await loadSettlementPageFor(owner, APRIL);
    const row = page.rows.find((r) => r.id === id)!;
    expect(row.blocked).toBeTruthy();
    const err = await rejects(markSettlementPaidFor(owner, id, "2025-04-03", null, APRIL));
    expect(err).toBeInstanceOf(SettlementError);
    expect((err as Error).message).toContain("Kan inte betalas än");
    expect((await stored(t)).paid_on).toBeNull();
  });

  it("Att göra ber om att räkna klart, inte att betala ett gammalt belopp", async () => {
    const todos = await loadTodosFor(owner, APRIL);
    const todo = todos.find((x) => x.kind === "settlement")!;
    expect(todo.title).toBe("Räkna klart avräkningen till Sega gubben Spärr");
  });
});

describe("jobbet sparar nya belopp på obetalda", () => {
  it("det sparade beloppet blir det som gäller nu (det butiken ser i portalen)", async () => {
    const t = await seedPortalTenant("Sega gubben Jobb");
    const owner = await viewerFor(t.owner, t.orgId);
    await ensureSettlementsFor(owner, APRIL);
    const { id } = await stored(t);
    await makeStale(id);
    const [run] = await createMonthlySettlements(db(), APRIL, { organizationIds: [t.orgId] });
    expect(run).toMatchObject({ created: 0, refreshed: 1, errors: [] });
    expect(Number((await stored(t)).amount_ore)).toBe(await bookShare(t));
    const [again] = await createMonthlySettlements(db(), APRIL, { organizationIds: [t.orgId] });
    expect(again).toMatchObject({ refreshed: 0 });
  });

  it("den 1:a skapar dagjobbet inget (rapportjobbet gör det)", async () => {
    const t = await seedPortalTenant("Sega gubben Första");
    const first = new Date("2025-04-01T08:00:00Z");
    const [run] = await createMonthlySettlements(db(), first, {
      organizationIds: [t.orgId],
      create: "not-first",
    });
    expect(run).toMatchObject({ created: 0 });
  });
});
