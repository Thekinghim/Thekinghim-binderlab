/**
 * "Visa detaljer i rapporten" (20261215000000_rapport_detaljer.sql).
 *
 * Butiksrapporten är kort som standard: uträkningen och summor, inga titlar. Butikens val
 * (stores.report_details, bara ägare och admin) lägger till titlar och service. Här
 * kontrolleras mot riktig Postgres:
 *
 * 1. Inställningen: standard av, vem som får ändra den (roller, RLS, andra organisationer).
 * 2. Valet läses när rapporten räknas och sparas i ögonblicksbilden.
 * 3. Regeln för sparade rapporter: en godkänd eller skickad rapport ändras inte när valet
 *    ändras; ett utkast blir inaktuellt och godkänns som ny version. Rapporter från före
 *    valet fanns: godkända visas som de skickades, utkast enligt den nya standarden.
 * 4. Butiksportalen: portal_report_details och portal_sales lämnar inte ut titlar när valet
 *    är av, och bara för den egna butiken.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { setStoreReportDetailsFor } from "@/app/(app)/butiker/_lib/service";
import { storeReportView } from "@/reports";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { loadPortalOverview } from "@/server/portal/load";
import {
  queryPortalReport,
  queryPortalReportDetails,
  queryPortalSales,
  queryPortalStores,
} from "@/server/portal/queries";
import { loadReportsPage } from "@/server/reports/page-data";
import {
  approveReportFor,
  createReportFor,
  getReportFor,
  markReportSharedFor,
  previewReportFor,
  ReportError,
  staleDraftFor,
} from "@/server/reports/service";
import type { StoreSnapshot } from "@/server/reports/snapshot";

import { affected, asPostgres, asUser, db, one, rows, settle, type TestUser } from "./helpers";
import { seedPortalFixture, type PortalFixture } from "./portal-fixture";

const MONTH = "2025-03";
const MARCH = { start: "2025-03-01", end: "2025-03-31" } as const;

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let f: PortalFixture;
let owner: Viewer;
let admin: Viewer;
let ownerB: Viewer;

async function setting(storeId: string): Promise<boolean> {
  const row = await asPostgres((tx) =>
    one<{ report_details: boolean }>(
      tx,
      sql`select report_details from public.stores where id = ${storeId}`,
    ),
  );
  return row.report_details;
}

async function storeSnapshot(viewer: Viewer, id: string): Promise<StoreSnapshot> {
  const snap = (await getReportFor(viewer, id)).snapshot;
  if (snap.type !== "butik") throw new Error("fel typ");
  return snap;
}

const create = (storeId: string) =>
  createReportFor(owner, { type: "butik", month: MONTH, storeId });

/** En rapport från före valet fanns: samma underlag med titlar, men utan sparat val. */
async function insertLegacy(fromReportId: string, approved: boolean): Promise<string> {
  return asPostgres(async (tx) => {
    const row = await one<{ id: string }>(
      tx,
      sql`insert into public.reports (organization_id, kind, period_start, period_end, store_id,
                                      storage_path, data_snapshot, calc_version, generated_at)
          select organization_id, kind, period_start, period_end, store_id,
                 organization_id::text || '/reports/aldre-' || gen_random_uuid()::text || '.pdf',
                 data_snapshot #- '{report,details}', calc_version, now() + interval '1 second'
          from public.reports where id = ${fromReportId}
          returning id`,
    );
    if (approved) {
      await tx.execute(
        sql`insert into public.report_approvals (organization_id, report_id)
            select organization_id, id from public.reports where id = ${row.id}`,
      );
    }
    return row.id;
  });
}

beforeAll(async () => {
  f = await seedPortalFixture();
  owner = await viewerFor(f.a.owner, f.a.orgId);
  admin = await viewerFor(f.adminA, f.a.orgId);
  ownerB = await viewerFor(f.b.owner, f.b.orgId);
});

describe("inställningen på butiken", () => {
  it("är av som standard", async () => {
    expect(await setting(f.a.storeId)).toBe(false);
    expect(await setting(f.a2.storeId)).toBe(false);
    expect(await setting(f.b.storeId)).toBe(false);
  });

  it("ägare och admin slår på och av", async () => {
    expect(await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: true })).toEqual(
      { ok: true, data: undefined },
    );
    expect(await setting(f.a2.storeId)).toBe(true);
    expect(
      await setStoreReportDetailsFor(admin, { storeId: f.a2.storeId, details: false }),
    ).toEqual({ ok: true, data: undefined });
    expect(await setting(f.a2.storeId)).toBe(false);
  });

  it("läsare, påfyllare och butiksanvändare får inte ändra (tjänsten)", async () => {
    for (const u of [f.viewerA, f.refillerA, f.storeA1]) {
      const viewer: Viewer = {
        user: { userId: u.id, email: u.email },
        organization: owner.organization,
      };
      const res = await setStoreReportDetailsFor(viewer, { storeId: f.a.storeId, details: true });
      expect(res).toEqual({ ok: false, error: "Bara ägare och admin kan ändra butiker." });
    }
    expect(await setting(f.a.storeId)).toBe(false);
  });

  it("läsare, påfyllare och butiksanvändare kan inte ändra kolumnen direkt (RLS)", async () => {
    for (const u of [f.viewerA, f.refillerA, f.storeA1, f.storeB1]) {
      const outcome = await settle(
        asUser(u, (tx) =>
          affected(
            tx,
            sql`update public.stores set report_details = true where id = ${f.a.storeId}`,
          ),
        ),
      );
      // Antingen nekas frågan helt (rollen store har inga tabellrättigheter) eller så
      // träffar den ingen rad.
      if (outcome.ok) expect(outcome.value).toBe(0);
      else expect(outcome.code).toBe("42501");
    }
    expect(await setting(f.a.storeId)).toBe(false);
  });

  it("en annan organisations ägare når inte butiken", async () => {
    // Som ägare i sin egen organisation: butiken finns inte där.
    expect(await setStoreReportDetailsFor(ownerB, { storeId: f.a.storeId, details: true })).toEqual(
      {
        ok: false,
        error: "Butiken finns inte.",
      },
    );
    // Med den andra organisationen angiven: ingen roll där.
    const forged: Viewer = { user: ownerB.user, organization: owner.organization };
    expect(await setStoreReportDetailsFor(forged, { storeId: f.a.storeId, details: true })).toEqual(
      {
        ok: false,
        error: "Bara ägare och admin kan ändra butiker.",
      },
    );
    const direct = await asUser(f.b.owner, (tx) =>
      affected(tx, sql`update public.stores set report_details = true where id = ${f.a.storeId}`),
    );
    expect(direct).toBe(0);
    expect(await setting(f.a.storeId)).toBe(false);
  });

  it("avvisar ogiltig indata", async () => {
    const res = await setStoreReportDetailsFor(owner, { storeId: "x", details: "ja" });
    expect(res.ok).toBe(false);
  });
});

describe("valet läses när rapporten räknas", () => {
  it("av (standard): rapporten sparas utan titlar och visas kort", async () => {
    const id = await create(f.a.storeId);
    const snap = await storeSnapshot(owner, id);
    expect(snap.report.details).toBe(false);
    expect(snap.report.topTitles).toEqual([]);
    expect(JSON.stringify(snap.report)).not.toContain("Pokémon 151 Booster");
    expect(JSON.stringify(snap.report)).not.toContain("Surging Sparks Booster");
    const view = storeReportView(snap.report);
    expect(view.sections).toEqual(["calculation", "weeks", "machines"]);
    expect(view.closing).toBe("Underlag per titel finns på begäran.");
    // Summorna finns kvar: 79 kr + 89 kr, provision 20 %.
    expect(snap.report.sales.revenueOre).toBe(16_800);
    expect(snap.report.sales.orders).toBe(2);
    expect(snap.report.compensation.totalOre).toBe(3_360);
  });

  it("förhandsvisningen på Rapporter följer valet", async () => {
    const off = await previewReportFor(owner, {
      type: "butik",
      month: MONTH,
      storeId: f.a.storeId,
    });
    expect(off.type === "butik" && off.report.details).toBe(false);
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: true });
    const on = await previewReportFor(owner, {
      type: "butik",
      month: MONTH,
      storeId: f.a2.storeId,
    });
    expect(on.type === "butik" && on.report.details).toBe(true);
    expect(on.type === "butik" && on.report.topTitles.map((t) => t.name)).toEqual([
      "Pokémon 151 Booster",
      "Surging Sparks Booster",
    ]);
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: false });
  });

  it("valet gäller bara den butiken", async () => {
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: true });
    const a1 = await previewReportFor(owner, { type: "butik", month: MONTH, storeId: f.a.storeId });
    expect(a1.type === "butik" && a1.report.details).toBe(false);
    expect(a1.type === "butik" && a1.report.topTitles).toEqual([]);
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: false });
  });
});

describe("regeln för sparade rapporter", () => {
  let approved: string;
  let draft: string;

  it("en godkänd rapport ändras inte när valet slås på", async () => {
    approved = await create(f.a.storeId);
    await approveReportFor(owner, approved, null);
    await setStoreReportDetailsFor(owner, { storeId: f.a.storeId, details: true });
    const snap = await storeSnapshot(owner, approved);
    expect(snap.report.details).toBe(false);
    expect(snap.report.topTitles).toEqual([]);
    // Butiken ser samma rapport i portalen: utan titlar.
    const portal = await asUser(f.storeA1, (tx) => queryPortalReport(tx, f.a.storeId, approved));
    const report = portal.report as { details?: boolean; topTitles?: unknown[] };
    expect(report.details).toBe(false);
    expect(report.topTitles).toEqual([]);
  });

  it("en skickad rapport ändras inte heller", async () => {
    await markReportSharedFor(owner, approved);
    const report = await getReportFor(owner, approved);
    expect(report.status).toBe("sent");
    expect(report.snapshot.type === "butik" && report.snapshot.report.details).toBe(false);
  });

  it("en ny rapport följer det nya valet (med titlar)", async () => {
    draft = await create(f.a.storeId);
    const snap = await storeSnapshot(owner, draft);
    expect(snap.report.details).toBe(true);
    expect(snap.report.topTitles.map((t) => t.name)).toEqual([
      "Surging Sparks Booster",
      "Pokémon 151 Booster",
    ]);
    expect(await staleDraftFor(owner, draft)).toBeNull();
  });

  it("ett utkast blir inaktuellt när valet ändras och kan inte godkännas", async () => {
    await setStoreReportDetailsFor(owner, { storeId: f.a.storeId, details: false });
    const stale = await staleDraftFor(owner, draft);
    expect(stale).not.toBeNull();
    // Beloppet är detsamma: det är innehållet som har ändrats.
    expect(stale!.draftOre).toBe(stale!.nowOre);
    const page = await loadReportsPage(owner, { typ: "butik", manad: MONTH, butiken: f.a.storeId });
    expect(page.current?.id).toBe(draft);
    expect(page.currentStale).toEqual(stale);
    expect(page.preview?.type === "butik" && page.preview.report.details).toBe(false);
    const err = await approveReportFor(owner, draft, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReportError);
    expect((err as Error).message).toBe(
      "Rapporten har ändrats sedan utkastet skapades. Skapa en ny version och godkänn den.",
    );
    // Utkastet självt visar fortfarande det som sparades i det.
    expect((await storeSnapshot(owner, draft)).report.details).toBe(true);
  });

  it("den nya versionen är kort och kan godkännas", async () => {
    const next = await create(f.a.storeId);
    expect((await storeSnapshot(owner, next)).report.details).toBe(false);
    expect(await staleDraftFor(owner, next)).toBeNull();
    await approveReportFor(owner, next, null);
    expect((await getReportFor(owner, next)).approvedAt).not.toBeNull();
  });
});

describe("rapporter från före valet fanns (inget sparat val)", () => {
  let source: string;

  beforeAll(async () => {
    // Underlaget med titlar, som rapporterna såg ut förut.
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: true });
    source = await create(f.a2.storeId);
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: false });
  });

  it("en godkänd rapport visas som den skickades, med titlar och service", async () => {
    const id = await insertLegacy(source, true);
    const raw = await asPostgres((tx) =>
      one<{ has: boolean }>(
        tx,
        sql`select data_snapshot -> 'report' ? 'details' as has from public.reports where id = ${id}`,
      ),
    );
    expect(raw.has).toBe(false);
    const snap = await storeSnapshot(owner, id);
    expect(snap.report.details).toBe(true);
    expect(snap.report.topTitles.length).toBeGreaterThan(0);
    expect(storeReportView(snap.report).sections).toContain("titles");
    // Ingenting skrivs tillbaka: ögonblicksbilden i databasen är orörd.
    const after = await asPostgres((tx) =>
      one<{ has: boolean }>(
        tx,
        sql`select data_snapshot -> 'report' ? 'details' as has from public.reports where id = ${id}`,
      ),
    );
    expect(after.has).toBe(false);
  });

  it("ett utkast visas kort, är inaktuellt och godkänns först som ny version", async () => {
    const id = await insertLegacy(source, false);
    const snap = await storeSnapshot(owner, id);
    expect(snap.report.details).toBe(false);
    expect(storeReportView(snap.report).sections).not.toContain("titles");
    expect(await staleDraftFor(owner, id)).not.toBeNull();
    const err = await approveReportFor(owner, id, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReportError);
    // Slås valet på för butiken är det äldre utkastet ändå inaktuellt (valet sparas i
    // den nya versionen, så att det som granskas är det som skickas).
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: true });
    expect(await staleDraftFor(owner, id)).not.toBeNull();
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: false });
    // Den äldre raden är daterad en sekund framåt (insertLegacy): den nya versionen senare.
    const later = new Date(Date.now() + 10_000);
    const next = await createReportFor(
      owner,
      { type: "butik", month: MONTH, storeId: f.a2.storeId },
      later,
    );
    expect((await storeSnapshot(owner, next)).report.details).toBe(false);
    await approveReportFor(owner, next, null, later);
    expect((await getReportFor(owner, next)).approvedAt).not.toBeNull();
  });
});

describe("butiksportalen", () => {
  beforeAll(async () => {
    await setStoreReportDetailsFor(owner, { storeId: f.a.storeId, details: false });
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: false });
  });

  it("portal_report_details: butiken läser sitt eget val", async () => {
    expect(await asUser(f.storeA1, (tx) => queryPortalReportDetails(tx, f.a.storeId))).toBe(false);
    await setStoreReportDetailsFor(owner, { storeId: f.a.storeId, details: true });
    expect(await asUser(f.storeA1, (tx) => queryPortalReportDetails(tx, f.a.storeId))).toBe(true);
    // Den andra butiken i samma organisation har sitt eget val.
    expect(await asUser(f.storeA2, (tx) => queryPortalReportDetails(tx, f.a2.storeId))).toBe(false);
    await setStoreReportDetailsFor(owner, { storeId: f.a.storeId, details: false });
  });

  it("portal_report_details: ingen annan når valet", async () => {
    for (const [user, storeId] of [
      [f.storeA2, f.a.storeId],
      [f.storeB1, f.a.storeId],
      [f.a.owner, f.a.storeId],
      [f.viewerA, f.a.storeId],
      [f.refillerA, f.a.storeId],
      [f.b.owner, f.a.storeId],
    ] as const) {
      const outcome = await settle(asUser(user, (tx) => queryPortalReportDetails(tx, storeId)));
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe("42501");
    }
  });

  it("portal_sales: utan valet lämnas inga titlar ut, men summorna är desamma", async () => {
    const off = await asUser(f.storeA2, (tx) => queryPortalSales(tx, f.a2.storeId, MARCH));
    expect(off.length).toBeGreaterThan(0);
    for (const row of off) {
      expect(row.titleId).toBeNull();
      expect(row.titleName).toBe("Alla titlar");
    }
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: true });
    const on = await asUser(f.storeA2, (tx) => queryPortalSales(tx, f.a2.storeId, MARCH));
    expect(new Set(on.map((r) => r.titleName))).toEqual(
      new Set(["Pokémon 151 Booster", "Surging Sparks Booster"]),
    );
    const sum = (list: typeof on) => list.reduce((n, r) => n + r.amountOre * r.orderCount, 0);
    const count = (list: typeof on) => list.reduce((n, r) => n + r.orderCount, 0);
    expect(sum(off)).toBe(sum(on));
    expect(sum(off)).toBe(12_900 + 12_900 + 9_900);
    expect(count(off)).toBe(count(on));
    // Valet för en butik ändrar inte den andra butikens försäljning.
    const other = await asUser(f.storeA1, (tx) => queryPortalSales(tx, f.a.storeId, MARCH));
    for (const row of other) expect(row.titleId).toBeNull();
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: false });
  });

  it("översikten: inga titlar utan valet, titlar med det, samma ersättning", async () => {
    const user: SessionUser = { userId: f.storeA2.id, email: f.storeA2.email };
    const stores = await asUser(f.storeA2, (tx) => queryPortalStores(tx));
    const ctx = { user, store: stores[0]!, stores };
    const off = await loadPortalOverview(ctx, MONTH);
    expect(off.details).toBe(false);
    expect(off.overview.report.details).toBe(false);
    expect(off.overview.report.topTitles).toEqual([]);
    expect(JSON.stringify(off.overview.report)).not.toContain("Pokémon");
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: true });
    const on = await loadPortalOverview(ctx, MONTH);
    expect(on.details).toBe(true);
    expect(on.overview.report.topTitles.map((t) => t.name)).toEqual([
      "Pokémon 151 Booster",
      "Surging Sparks Booster",
    ]);
    expect(on.overview.report.sales).toEqual(off.overview.report.sales);
    expect(on.overview.report.compensation.totalOre).toBe(
      off.overview.report.compensation.totalOre,
    );
    await setStoreReportDetailsFor(owner, { storeId: f.a2.storeId, details: false });
  });

  it("funktionerna kan inte köras av anon", async () => {
    const fns = await rows<{ name: string; anon: boolean; auth: boolean }>(
      db(),
      sql`select p.proname as name,
                 has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                 has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in ('portal_report_details', 'portal_sales')`,
    );
    expect(fns).toHaveLength(2);
    for (const fn of fns) {
      expect(fn.anon, fn.name).toBe(false);
      expect(fn.auth, fn.name).toBe(true);
    }
  });
});
