/**
 * Förskott (store_payments), fall från granskningen. Testdatabasen med pengafixturen och en
 * påhittad butik till:
 *
 *   Nyplats    50 % av vinsten, automaten från 14 okt. (det riktiga fallets form).
 *   Vinsten    50 % av vinsten (pengafixturen).
 *   Provision  10 % av försäljningen (pengafixturen).
 *
 * 1. Det riktiga fallets form, och att avräkningens PDF (ägarens och butikens) visar
 *    förskottet och "Kvar att betala".
 * 2. En avräkning betald med betalningarna som också bär en rättelse för oktober: rättelsen
 *    räknas en gång i butiksrapporten.
 * 3. Förskotten blir fler än avräkningen när beloppet sjunker: "Markera som betald" och
 *    "Räkna om" gör den betald med betalningarna, och för mycket står kvar som skillnad.
 * 4. paid_from_payments kan inte sättas utan betalningar som täcker avräkningen, och en
 *    sådan avräkning utan betalningar kvar går att ångra.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
  unstable_noStore: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

import { withUserDbFor, type SessionUser } from "@/server/access";
import { queryPortalStores } from "@/server/portal/queries";
import { loadPortalSettlementDocument } from "@/server/portal/settlements";
import { queryStoreBasis } from "@/server/reports/sources";
import { previewPaymentFor, registerPaymentFor } from "@/server/settlements/payments";
import { queryUnpaidSettlements } from "@/server/settlements/queries";
import {
  carryDifferenceFor,
  createMonthlySettlements,
  ensureSettlementsFor,
  loadSettlementPageFor,
  markSettlementPaidFor,
  recomputeSettlementFor,
  settlementDocumentFor,
  undoSettlementPaidFor,
} from "@/server/settlements/service";
import { krText } from "@/reports";

import { asPostgres, asUser, attempt, createUser, db, one } from "./helpers";
import { seedMoneyFixture, settlementId, type MoneyFixture } from "./pengar-fixture";

const NOV = new Date("2026-11-19T10:00:00Z");
const DEC = new Date("2026-12-02T10:00:00Z");
const plain = (t: string) => t.replace(/[\u00a0\u202f]/g, " ");

const rowOf = async (f: MoneyFixture, id: string, now: Date) =>
  (await loadSettlementPageFor(f.owner, now)).rows.find((r) => r.id === id)!;
const basisPaid = async (f: MoneyFixture, storeId: string, start: string, end: string) =>
  (
    await withUserDbFor(f.owner.user, (tx) =>
      queryStoreBasis(
        tx,
        { id: f.orgId, name: "x", timeZone: "Europe/Stockholm" } as never,
        storeId,
        { start, end } as never,
      ),
    )
  ).payments ?? [];
const sum = (xs: readonly { amountOre: number }[]) => xs.reduce((n, x) => n + x.amountOre, 0);

let f: MoneyFixture;
let ny: string;
let m3: string;

beforeAll(async () => {
  f = await seedMoneyFixture("Förskott granskning");
  const ids = await asPostgres(async (tx) => {
    const s = (
      await one<{ id: string }>(
        tx,
        sql`insert into public.stores (organization_id, name) values (${f.orgId}, 'Nyplats') returning id`,
      )
    ).id;
    await tx.execute(sql`insert into public.store_agreements
      (organization_id, store_id, valid_from, commission_base, commission_bp)
      values (${f.orgId}, ${s}, '2026-10-14', 'profit_after_costs', 5000)`);
    const m = (
      await one<{ id: string }>(
        tx,
        sql`insert into public.machines (organization_id, code, name, active_from)
            values (${f.orgId}, 'BL-003', 'BL-003', '2026-10-14') returning id`,
      )
    ).id;
    await tx.execute(sql`insert into public.machine_placements
      (organization_id, machine_id, store_id, valid_from)
      values (${f.orgId}, ${m}, ${s}, '2026-10-14')`);
    return { s, m };
  });
  ny = ids.s;
  m3 = ids.m;
  let n = 0;
  const order = (day: string, ore: number) =>
    asPostgres((tx) => {
      n += 1;
      return tx.execute(sql`insert into public.orders (organization_id, data_source_id,
              external_id, raw_title, title_id, ordered_at, amount_ore, machine_id, source_hash)
            values (${f.orgId}, ${f.sourceId}, ${`gr-${n}`}, 'Pack', ${f.titleId},
              ${`${day}T10:00:00Z`}, ${ore}, ${m3}, ${`grh-${n}`})`);
    });
  await order("2026-10-15", 20_000);
  await order("2026-10-25", 20_000);
  await order("2026-11-03", 10_000);
  await order("2026-11-10", 10_000);
  await order("2026-11-20", 30_000);
  await f.order("m1", "2026-11-05", 10_000);
  await f.order("m2", "2026-11-06", 30_000);
  vi.useFakeTimers({ toFake: ["Date"], now: NOV });
  await ensureSettlementsFor(f.owner, NOV);
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

describe("1. det riktiga fallets form, och avräkningens PDF", () => {
  it("oktober oförändrad, november drar av förskottet: sidan, Hem, rapporten och PDF:en", async () => {
    vi.setSystemTime(NOV);
    const oct = await settlementId(f.orgId, ny, "2026-10");
    const octOre = (await rowOf(f, oct, NOV)).amountOre;
    expect(octOre).toBeGreaterThan(0);
    await markSettlementPaidFor(f.owner, oct, "2026-11-16", octOre, NOV);
    const input = {
      storeId: ny,
      paidOn: "2026-11-16",
      amountOre: octOre + 1_234,
      periodStart: "2026-10-14",
      periodEnd: "2026-11-14",
    };
    const preview = await previewPaymentFor(f.owner, input, NOV);
    expect(preview.parts.map((p) => [p.month, p.amountOre, p.effect])).toEqual([
      ["2026-10", octOre, "Ingår i det som betalades för oktober"],
      ["2026-11", 1_234, "Dras av när avräkningen för november skapas"],
    ]);
    await registerPaymentFor(f.owner, input, [octOre, 1_234], NOV);
    expect(await rowOf(f, oct, NOV)).toMatchObject({ paidOn: "2026-11-16", differenceOre: 0 });

    vi.setSystemTime(DEC);
    await createMonthlySettlements(db(), DEC, { organizationIds: [f.orgId] });
    const nov = await settlementId(f.orgId, ny, "2026-11");
    const row = await rowOf(f, nov, DEC);
    expect(row.paidOn).toBeNull();
    expect(row.leftOre).toBe(row.amountOre - 1_234);
    expect(plain(row.advanceText!)).toBe(
      "Redan betalt i förskott 12,34 kr (1–14 nov., betalt 16 nov.)",
    );
    const unpaid = await withUserDbFor(f.owner.user, (tx) =>
      queryUnpaidSettlements(tx, f.orgId, DEC),
    );
    expect(unpaid.find((u) => u.id === nov)?.amountOre).toBe(row.amountOre - 1_234);
    expect(sum(await basisPaid(f, ny, "2026-10-14", "2026-11-14"))).toBe(octOre + 1_234);

    // Ägarens PDF.
    const doc = plain((await settlementDocumentFor(f.owner, nov, DEC)).html);
    expect(doc).toContain("Redan betalt i förskott");
    expect(doc).toContain("1–14 november 2026, betalt 16 november 2026");
    expect(doc).toContain(
      `Kvar att betala</td><td class="n">${plain(krText(row.amountOre - 1_234))}`,
    );
    expect(doc).toContain(`<p class="amount">${plain(krText(row.amountOre - 1_234))}</p>`);
    // Oktober är betald: inget dras av, förskottet ingår i det betalda.
    const octDoc = plain((await settlementDocumentFor(f.owner, oct, DEC)).html);
    expect(octDoc).not.toContain("Kvar att betala");
    expect(octDoc).toContain(`<p class="amount">${plain(krText(octOre))}</p>`);

    // Butikens PDF i portalen.
    const storeUser = await createUser();
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.memberships (organization_id, user_id, role, store_id)
        values (${f.orgId}, ${storeUser.id}, 'store', ${ny})`),
    );
    const user: SessionUser = { userId: storeUser.id, email: storeUser.email };
    const stores = await withUserDbFor(user, queryPortalStores);
    const portal = await loadPortalSettlementDocument(
      { user, store: stores.find((x) => x.storeId === ny)!, stores },
      nov,
    );
    expect(plain(portal!.html)).toContain("Redan betalt i förskott");
    expect(plain(portal!.html)).toContain("Kvar att betala");
  });
});

describe("2. betald med betalningarna och med en rättelse för oktober", () => {
  it("rättelsen räknas en gång i butiksrapporten", async () => {
    vi.setSystemTime(DEC);
    const oct = await settlementId(f.orgId, f.stores.vinsten, "2026-10");
    const octOre = (await rowOf(f, oct, DEC)).amountOre;
    await markSettlementPaidFor(f.owner, oct, "2026-11-10", octOre, DEC);
    await f.order("m1", "2026-10-22", 10_000);
    const after = await rowOf(f, oct, DEC);
    expect(after.differenceOre).toBeGreaterThan(0);
    await carryDifferenceFor(f.owner, oct, after.differenceOre, DEC);
    const nov = await settlementId(f.orgId, f.stores.vinsten, "2026-11");
    const novOre = (await rowOf(f, nov, DEC)).amountOre;
    const novShare = novOre - after.differenceOre;
    const res = await registerPaymentFor(
      f.owner,
      {
        storeId: f.stores.vinsten,
        paidOn: "2026-11-19",
        amountOre: novOre,
        periodStart: "2026-11-01",
        periodEnd: "2026-11-30",
      },
      null,
      DEC,
    );
    expect(res.settledMonths).toEqual(["2026-11"]);
    expect(sum(await basisPaid(f, f.stores.vinsten, "2026-11-01", "2026-11-30"))).toBe(novShare);
    expect(sum(await basisPaid(f, f.stores.vinsten, "2026-10-01", "2026-10-31"))).toBe(
      octOre + after.differenceOre,
    );
    expect(sum(await basisPaid(f, f.stores.vinsten, "2026-10-01", "2026-11-30"))).toBe(
      octOre + novOre,
    );
  });
});

describe("3. förskotten blir fler än avräkningen", () => {
  it("Markera som betald: betald med betalningarna, för mycket står kvar", async () => {
    vi.setSystemTime(DEC);
    const nov = await settlementId(f.orgId, ny, "2026-11");
    const r0 = await rowOf(f, nov, DEC);
    await registerPaymentFor(
      f.owner,
      {
        storeId: ny,
        paidOn: "2026-11-19",
        amountOre: r0.leftOre - 100,
        periodStart: "2026-11-15",
        periodEnd: "2026-11-30",
      },
      null,
      DEC,
    );
    const r1 = await rowOf(f, nov, DEC);
    expect(r1).toMatchObject({ paidOn: null, leftOre: 100 });
    // Köpet 20 nov. var ett testköp: beloppet sjunker under förskotten.
    await asPostgres((tx) =>
      tx.execute(sql`update public.orders set test_purchase_at = now()
        where organization_id = ${f.orgId} and machine_id = ${m3}
          and ordered_at::date = '2026-11-20'`),
    );
    const r2 = await rowOf(f, nov, DEC);
    expect(r2.paidOn).toBeNull();
    expect(r2.leftOre).toBeLessThan(0);
    const overOre = -r2.leftOre;
    const unpaid = await withUserDbFor(f.owner.user, (tx) =>
      queryUnpaidSettlements(tx, f.orgId, DEC),
    );
    expect(unpaid.find((u) => u.id === nov)).toBeUndefined();

    const res = await markSettlementPaidFor(f.owner, nov, "2026-11-20", r2.amountOre, DEC);
    expect(res).toMatchObject({
      paidFromPayments: true,
      paidOre: r2.advanceOre,
      differenceOre: -overOre,
    });
    const r3 = await rowOf(f, nov, DEC);
    expect(r3).toMatchObject({
      paidFromPayments: true,
      paidOre: r2.advanceOre,
      differenceOre: -overOre,
      paidOn: "2026-11-19",
    });
    // Ångras genom att ta bort betalningen, inte här.
    await expect(undoSettlementPaidFor(f.owner, nov)).rejects.toThrow("Ta bort betalningen");
  });

  it("Räkna om: betald med betalningarna när förskottet täcker det nya beloppet", async () => {
    vi.setSystemTime(DEC);
    const nov = await settlementId(f.orgId, f.stores.provision, "2026-11");
    const r0 = await rowOf(f, nov, DEC);
    expect(r0.amountOre).toBeGreaterThan(1);
    await registerPaymentFor(
      f.owner,
      {
        storeId: f.stores.provision,
        paidOn: "2026-11-19",
        amountOre: r0.amountOre - 1,
        periodStart: "2026-11-01",
        periodEnd: "2026-11-30",
      },
      null,
      DEC,
    );
    expect((await rowOf(f, nov, DEC)).paidOn).toBeNull();
    await asPostgres((tx) =>
      tx.execute(sql`update public.orders set test_purchase_at = now()
        where organization_id = ${f.orgId} and machine_id = ${f.machines.m2}
          and ordered_at::date = '2026-11-06'`),
    );
    await recomputeSettlementFor(f.owner, nov, DEC);
    const r1 = await rowOf(f, nov, DEC);
    expect(r1).toMatchObject({ paidFromPayments: true, paidOre: r0.amountOre - 1 });
    expect(r1.differenceOre).toBe(r1.liveOre! - (r0.amountOre - 1));
    expect(r1.differenceOre).toBeLessThan(0);
  });
});

describe("4. paid_from_payments och betalningarna", () => {
  it("ägaren kan inte sätta den utan betalningar som täcker avräkningen", async () => {
    const oct = await settlementId(f.orgId, f.stores.provision, "2026-10");
    const r = await asUser(f.ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.store_settlements
          set paid_on = '2026-11-01', paid_from_payments = true
          where id = ${oct} returning id`),
      ),
    );
    expect(r).toMatchObject({ ok: false, code: "BL081" });
    // Utan paid_from_payments går det som förut (Markera som betald).
    const plainPaid = await asUser(f.ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.store_settlements set paid_on = '2026-11-01'
          where id = ${oct} returning id`),
      ),
    );
    expect(plainPaid.ok).toBe(true);
  });

  it("betalningen borttagen direkt i databasen: avräkningen går att ångra", async () => {
    vi.setSystemTime(DEC);
    const nov = await settlementId(f.orgId, ny, "2026-11");
    expect((await rowOf(f, nov, DEC)).paidFromPayments).toBe(true);
    await asPostgres((tx) =>
      tx.execute(sql`delete from public.store_payments
        where organization_id = ${f.orgId} and store_id = ${ny}`),
    );
    const page = await rowOf(f, nov, DEC);
    expect(page).toMatchObject({ paidFromPayments: true, advanceOre: 0 });
    await undoSettlementPaidFor(f.owner, nov);
    expect(await rowOf(f, nov, DEC)).toMatchObject({ paidOn: null, paidFromPayments: false });
  });
});
