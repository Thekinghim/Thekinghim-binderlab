/**
 * Betalning till en butik för en egen period (store_payments, 20261221000000), testdatabasen
 * med pengafixturen (påhittade butiker):
 *
 *   Vinsten    50 % av vinsten: oktober 60 kr, november 60 kr (order 5 och 20 nov.).
 *   Provision  10 % av försäljningen.
 *
 * A. Det riktiga fallets form: oktober är betald 16 nov. Betalningen 16 nov. gäller 5 okt.–
 *    14 nov.: oktober får det som betalades för den, resten är förskott för november. Ingen
 *    novemberavräkning finns än. När den skapas 1 dec. dras förskottet av.
 * B. En betalning över två obetalda avräkningar täcker båda: de blir betalda med
 *    betalningen och oktober stängs. Borttagningen nekas i den stängda månaden tills ägaren
 *    öppnar den, och gör sedan båda obetalda igen.
 * C. Mer betalt än avräkningen: betald med betalningen, och "för mycket" syns som en
 *    skillnad som kan läggas på nästa avräkning.
 * D. RLS: ägare och admin skriver, läsaren läser, påfyllaren, butiken och andra
 *    organisationer ser inget. Butiken ser delarna för sin egen butik i portalen.
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

import { withUserDbFor } from "@/server/access";
import { queryStoreBasis } from "@/server/reports/sources";
import { reopenMonthFor } from "@/server/periods/service";
import { queryClosedMonthKeys } from "@/server/periods/service";
import {
  deletePaymentFor,
  loadPaymentListFor,
  previewPaymentFor,
  registerPaymentFor,
} from "@/server/settlements/payments";
import { queryUnpaidSettlements } from "@/server/settlements/queries";
import {
  createMonthlySettlements,
  ensureSettlementsFor,
  loadSettlementPageFor,
  markSettlementPaidFor,
  undoSettlementPaidFor,
} from "@/server/settlements/service";

import {
  asAnon,
  asPostgres,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
} from "./helpers";
import { seedMoneyFixture, settlementId, type MoneyFixture } from "./pengar-fixture";

const NOV = new Date("2026-11-19T10:00:00Z");
const DEC = new Date("2026-12-02T10:00:00Z");
const plain = (t: string) => t.replace(/[  ]/g, " ");

const rowOf = async (f: MoneyFixture, id: string, now: Date) =>
  (await loadSettlementPageFor(f.owner, now)).rows.find((r) => r.id === id)!;

let f: MoneyFixture;

beforeAll(async () => {
  f = await seedMoneyFixture("Förskott");
  // November hos Vinsten: två köp, samma som oktober.
  await f.order("m1", "2026-11-05", 10_000);
  await f.order("m1", "2026-11-20", 10_000);
  await f.order("m2", "2026-11-06", 30_000);
  vi.useFakeTimers({ toFake: ["Date"], now: NOV });
  await ensureSettlementsFor(f.owner, NOV);
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

describe("A. förskott för en månad utan avräkning", () => {
  let oct: string;
  let paymentId: string;

  it("oktober är betald 16 nov. med sitt belopp", async () => {
    oct = await settlementId(f.orgId, f.stores.vinsten, "2026-10");
    expect((await rowOf(f, oct, NOV)).amountOre).toBe(6_000);
    await markSettlementPaidFor(f.owner, oct, "2026-11-16", 6_000, NOV);
  });

  it("förhandsvisningen: oktober får det som betalades, november resten", async () => {
    const preview = await previewPaymentFor(
      f.owner,
      {
        storeId: f.stores.vinsten,
        paidOn: "2026-11-16",
        amountOre: 9_000,
        periodStart: "2026-10-05",
        periodEnd: "2026-11-14",
      },
      NOV,
    );
    expect(preview.parts.map((p) => [p.month, p.start, p.end, p.amountOre, p.effect])).toEqual([
      ["2026-10", "2026-10-05", "2026-10-31", 6_000, "Ingår i det som betalades för oktober"],
      ["2026-11", "2026-11-01", "2026-11-14", 3_000, "Dras av när avräkningen för november skapas"],
    ]);
  });

  it("registreras bara med den uppdelning som visades", async () => {
    const input = {
      storeId: f.stores.vinsten,
      paidOn: "2026-11-16",
      amountOre: 9_000,
      periodStart: "2026-10-05",
      periodEnd: "2026-11-14",
      note: "Betalt för 5 okt.–14 nov.",
    };
    await expect(registerPaymentFor(f.owner, input, [5_000, 4_000], NOV)).rejects.toThrow(
      "Uppdelningen har ändrats",
    );
    const res = await registerPaymentFor(f.owner, input, [6_000, 3_000], NOV);
    paymentId = res.id;
    expect(res.settledMonths).toEqual([]);
    // Oktober ändras inte: betald som förut, inget dras av eller läggs till.
    const row = await rowOf(f, oct, NOV);
    expect(row).toMatchObject({ paidOn: "2026-11-16", paidOre: 6_000, differenceOre: 0 });
    expect(row.advanceText).toBeNull();
  });

  it("listan visar betalningen och vad delarna gör", async () => {
    const list = await loadPaymentListFor(f.owner);
    const p = list.find((x) => x.id === paymentId)!;
    expect(p).toMatchObject({
      amountOre: 9_000,
      note: "Betalt för 5 okt.–14 nov.",
      deleteBlocked: null,
    });
    expect(p.parts.map((x) => x.effect)).toEqual([
      "Ingår i det som betalades för oktober",
      "Dras av när avräkningen för november skapas",
    ]);
  });

  it("1 dec.: novemberavräkningen skapas och förskottet dras av", async () => {
    vi.setSystemTime(DEC);
    await createMonthlySettlements(db(), DEC, { organizationIds: [f.orgId] });
    const nov = await settlementId(f.orgId, f.stores.vinsten, "2026-11");
    const row = await rowOf(f, nov, DEC);
    expect(row).toMatchObject({
      amountOre: 6_000,
      advanceOre: 3_000,
      leftOre: 3_000,
      paidOn: null,
    });
    expect(plain(row.advanceText!)).toBe(
      "Redan betalt i förskott 30,00 kr (1–14 nov., betalt 16 nov.)",
    );
    // Hem och Att göra: bara det som är kvar.
    const unpaid = await withUserDbFor(f.owner.user, (tx) =>
      queryUnpaidSettlements(tx, f.orgId, DEC),
    );
    expect(unpaid.find((u) => u.id === nov)?.amountOre).toBe(3_000);
  });
});

describe("A2. butiksrapporten för 14 okt.–14 nov. och för november", () => {
  const basis = (start: string, end: string) =>
    withUserDbFor(f.owner.user, (tx) =>
      queryStoreBasis(
        tx,
        { id: f.orgId, name: "Förskott", timeZone: "Europe/Stockholm" } as never,
        f.stores.vinsten,
        { start, end } as never,
      ),
    );

  it("oktober räknas som avräkningen, november som förskottet med sina dagar", async () => {
    const b = await basis("2026-10-14", "2026-11-14");
    expect(b.payments).toEqual([
      // Oktobers del av betalningen är samma pengar som oktobers avräkning: den står med
      // sina dagar, och avräkningens egen rad blir 0 kr (tas inte med).
      {
        paidOn: "2026-11-16",
        amountOre: 6_000,
        month: "2026-10",
        start: "2026-10-05",
        end: "2026-10-31",
      },
      {
        paidOn: "2026-11-16",
        amountOre: 3_000,
        month: "2026-11",
        start: "2026-11-01",
        end: "2026-11-14",
      },
    ]);
  });

  it("utan dubbelräkning: oktobers del av betalningen ingår i oktobers avräkning", async () => {
    const b = await basis("2026-10-01", "2026-10-31");
    expect(b.payments).toEqual([
      {
        paidOn: "2026-11-16",
        amountOre: 6_000,
        month: "2026-10",
        start: "2026-10-05",
        end: "2026-10-31",
      },
    ]);
  });
});

describe("B. en betalning över två obetalda avräkningar", () => {
  let oct: string;
  let nov: string;
  let paymentId: string;

  beforeAll(async () => {
    oct = await settlementId(f.orgId, f.stores.provision, "2026-10");
    nov = await settlementId(f.orgId, f.stores.provision, "2026-11");
  });

  it("täcker båda: betalda med betalningen, och oktober stängs", async () => {
    const octOre = (await rowOf(f, oct, DEC)).amountOre;
    const novOre = (await rowOf(f, nov, DEC)).amountOre;
    expect(octOre).toBeGreaterThan(0);
    const res = await registerPaymentFor(
      f.owner,
      {
        storeId: f.stores.provision,
        paidOn: "2026-11-19",
        amountOre: octOre + novOre,
        periodStart: "2026-10-01",
        periodEnd: "2026-11-30",
      },
      null,
      DEC,
    );
    paymentId = res.id;
    expect(res.parts.map((p) => p.amountOre)).toEqual([octOre, novOre]);
    expect(res.settledMonths).toEqual(["2026-10", "2026-11"]);
    // Oktober: Vinsten är betald för hand, Provision med betalningen: alla klara.
    expect(res.closedMonths).toEqual(["2026-10"]);
    const o = await rowOf(f, oct, DEC);
    expect(o).toMatchObject({ paidOn: "2026-11-19", paidFromPayments: true, differenceOre: 0 });
  });

  it("en avräkning betald med betalningen ångras inte för sig", async () => {
    await expect(undoSettlementPaidFor(f.owner, oct)).rejects.toThrow("Ta bort betalningen");
  });

  it("oktober är stängd: borttagningen nekas tills ägaren öppnar månaden", async () => {
    const list = await loadPaymentListFor(f.owner);
    expect(list.find((x) => x.id === paymentId)?.deleteBlocked).toMatch(/Oktober 2026 är stängd/);
    await expect(deletePaymentFor(f.owner, paymentId, DEC)).rejects.toThrow("är stängd");
    expect((await rowOf(f, oct, DEC)).paidOn).toBe("2026-11-19");
  });

  it("efter att månaden öppnats: borttagen, och båda är obetalda igen", async () => {
    await reopenMonthFor(f.owner, "2026-10", "Fel betalning registrerad");
    const res = await deletePaymentFor(f.owner, paymentId, DEC);
    expect(res.reopened).toEqual(["2026-10", "2026-11"]);
    expect(await rowOf(f, oct, DEC)).toMatchObject({ paidOn: null, paidFromPayments: false });
    expect((await rowOf(f, nov, DEC)).paidOn).toBeNull();
    const closed = await withUserDbFor(f.owner.user, (tx) => queryClosedMonthKeys(tx, f.orgId));
    expect(closed).not.toContain("2026-10");
  });
});

describe("C. mer betalt än avräkningen", () => {
  let nov: string;
  let paymentId: string;

  it("betald med betalningen, och skillnaden syns som för mycket", async () => {
    nov = await settlementId(f.orgId, f.stores.provision, "2026-11");
    const novOre = (await rowOf(f, nov, DEC)).amountOre;
    const res = await registerPaymentFor(
      f.admin,
      {
        storeId: f.stores.provision,
        paidOn: "2026-11-19",
        amountOre: novOre + 500,
        periodStart: "2026-11-01",
        periodEnd: "2026-11-30",
      },
      null,
      DEC,
    );
    paymentId = res.id;
    const row = await rowOf(f, nov, DEC);
    expect(row).toMatchObject({
      paidFromPayments: true,
      paidOre: novOre + 500,
      liveOre: novOre,
      differenceOre: -500,
    });
  });

  it("borttagen: obetald igen med hela beloppet kvar", async () => {
    await deletePaymentFor(f.admin, paymentId, DEC);
    const row = await rowOf(f, nov, DEC);
    expect(row).toMatchObject({ paidOn: null, advanceOre: 0, leftOre: row.amountOre });
  });

  it("delvis betalt: kvar att betala, och betald som vanligt med resten", async () => {
    const novOre = (await rowOf(f, nov, DEC)).amountOre;
    await registerPaymentFor(
      f.owner,
      {
        storeId: f.stores.provision,
        paidOn: "2026-11-16",
        amountOre: 1_000,
        periodStart: "2026-11-01",
        periodEnd: "2026-11-14",
      },
      null,
      DEC,
    );
    expect(await rowOf(f, nov, DEC)).toMatchObject({ leftOre: novOre - 1_000, paidOn: null });
    await markSettlementPaidFor(f.owner, nov, "2026-11-20", novOre, DEC);
    const row = await rowOf(f, nov, DEC);
    // Det betalda är hela avräkningen (förskottet och resten): ingen skillnad.
    expect(row).toMatchObject({ paidOre: novOre, differenceOre: 0, paidFromPayments: false });
  });

  it("en betalning för en betald månad som är mer än det betalda nekas", async () => {
    await expect(
      registerPaymentFor(
        f.owner,
        {
          storeId: f.stores.provision,
          paidOn: "2026-11-20",
          amountOre: 999_999,
          periodStart: "2026-11-15",
          periodEnd: "2026-11-30",
        },
        null,
        DEC,
      ),
    ).rejects.toThrow("November är redan betald");
  });
});

describe("D. vem som ser och ändrar", () => {
  const input = () => ({
    storeId: f.stores.vinsten,
    paidOn: "2026-11-19",
    amountOre: 100,
    periodStart: "2026-12-01",
    periodEnd: "2026-12-01",
  });

  it("läsaren läser men registrerar inte", async () => {
    const viewer = await createMember(f.orgId, "viewer");
    const n = await asUser(viewer, (tx) =>
      rows(tx, sql`select id from public.store_payments where organization_id = ${f.orgId}`),
    );
    expect(n.length).toBeGreaterThan(0);
    const ins = await asUser(viewer, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into public.store_payments
          (organization_id, store_id, paid_on, amount_ore, period_start, period_end, parts)
          values (${f.orgId}, ${f.stores.vinsten}, '2026-12-01', 100, '2026-12-01', '2026-12-01',
                  '[{"month":"2026-12","start":"2026-12-01","end":"2026-12-01","amountOre":100}]')`),
      ),
    );
    expect(ins.ok).toBe(false);
    const del = await asUser(viewer, (tx) =>
      tx.execute(
        sql`delete from public.store_payments where organization_id = ${f.orgId} returning id`,
      ),
    );
    expect(Array.from(del)).toHaveLength(0);
  });

  it("påfyllaren, butiken, en annan organisation och anon ser inget", async () => {
    const refiller = await createMember(f.orgId, "refiller");
    const storeUser = await createUser();
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.memberships (organization_id, user_id, role, store_id)
        values (${f.orgId}, ${storeUser.id}, 'store', ${f.stores.vinsten})`),
    );
    const otherOwner = await createUser();
    await createOrg(otherOwner, "Annan");
    for (const u of [refiller, storeUser, otherOwner]) {
      const got = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          rows(sp, sql`select id from public.store_payments where organization_id = ${f.orgId}`),
        ),
      );
      expect(got.ok ? got.value : []).toHaveLength(0);
    }
    const anon = await asAnon((tx) =>
      attempt(tx, (sp) => rows(sp, sql`select id from public.store_payments`)),
    );
    expect(anon.ok).toBe(false);

    // Butiken ser delarna för sin egen butik i portalen, utan anteckningen.
    const own = await asUser(storeUser, (tx) =>
      rows(tx, sql`select * from public.portal_store_payments(${f.stores.vinsten}::uuid)`),
    );
    expect(own.map((r) => Number(r.amount_ore)).sort()).toEqual([3_000, 6_000]);
    expect(Object.keys(own[0]!)).not.toContain("note");
    const other = await asUser(storeUser, (tx) =>
      attempt(tx, (sp) =>
        rows(sp, sql`select * from public.portal_store_payments(${f.stores.provision}::uuid)`),
      ),
    );
    expect(other.ok).toBe(false);
  });

  it("tjänsten nekar läsaren och påfyllaren", async () => {
    await expect(
      registerPaymentFor(
        { ...f.owner, user: { userId: "x", email: "x" } } as never,
        input(),
        null,
        DEC,
      ),
    ).rejects.toThrow();
  });

  it("databasen: delarna ska bli beloppet och följa perioden, och en betalning ändras inte", async () => {
    const bad = await asUser(f.ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into public.store_payments
          (organization_id, store_id, paid_on, amount_ore, period_start, period_end, parts)
          values (${f.orgId}, ${f.stores.vinsten}, '2026-11-19', 200, '2026-11-30', '2026-12-01',
                  '[{"month":"2026-11","start":"2026-11-30","end":"2026-11-30","amountOre":50},
                    {"month":"2026-12","start":"2026-12-01","end":"2026-12-01","amountOre":100}]')`),
      ),
    );
    expect(bad).toMatchObject({ ok: false, code: "BL082" });
    const p = await one<{ id: string }>(
      db(),
      sql`select id from public.store_payments where organization_id = ${f.orgId} limit 1`,
    );
    const upd = await asUser(f.ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.store_payments set note = 'x' where id = ${p.id}`),
      ),
    );
    expect(upd.ok).toBe(false);
  });
});
