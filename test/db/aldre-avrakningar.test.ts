/**
 * Avräkningar skapas också för äldre månader (testdatabasen, egen fixtur, "i dag" 19 nov.
 * 2026). Förut skapades och listades bara förra månaden: en butik vars avräkning inte gick
 * att räkna i tid föll bort för gott när månaden bytte.
 *
 *   september och oktober  båda butikerna sålde, inga avräkningar finns
 *   augusti                Vinsten (vinstdelning) sålde en titel utan inköpspris
 *   juli                   Provision sålde och månaden är stängd (bokföringen skickad):
 *                          butiken ska ha sin avräkning ändå
 *   juni                   organisationens första avräkning (Provision, 0 kr): härifrån räknas
 *   maj                    Provision sålde, före första avräkningen: betalt utanför appen
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
import { queryOlderMissingSettlements } from "@/server/settlements/queries";
import {
  createMonthlySettlements,
  ensureSettlementsFor,
  loadSettlementPageFor,
} from "@/server/settlements/service";

import { asPostgres, asUser, db, one, rows } from "./helpers";
import { seedMoneyFixture, type MoneyFixture } from "./pengar-fixture";

const NOW = new Date("2026-11-19T10:00:00Z");

let f: MoneyFixture;
let unpricedTitle: string;

const months = async () =>
  (
    await asPostgres((tx) =>
      rows<{ month: string; n: number }>(
        tx,
        sql`select to_char(month, 'YYYY-MM') as month, count(*)::int as n
            from public.store_settlements where organization_id = ${f.orgId}
            group by 1 order by 1`,
      ),
    )
  ).map((r) => `${r.month}:${r.n}`);

beforeAll(async () => {
  f = await seedMoneyFixture("Äldre avräkningar");
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await asPostgres(async (tx) => {
    unpricedTitle = (
      await one<{ id: string }>(
        tx,
        sql`insert into public.titles (organization_id, name) values (${f.orgId}, 'Utan pris')
            returning id`,
      )
    ).id;
    const order = (machine: string, title: string, day: string, key: string) =>
      tx.execute(sql`insert into public.orders (organization_id, data_source_id, external_id,
          raw_title, title_id, ordered_at, amount_ore, machine_id, source_hash)
        values (${f.orgId}, ${f.sourceId}, ${key}, 'x', ${title}, ${`${day}T10:00:00Z`}, 10000,
                ${machine}, ${`h-${key}-${f.orgId.slice(0, 8)}`})`);
    await order(f.machines.m1, unpricedTitle, "2026-08-10", "aug-1");
    await order(f.machines.m2, f.titleId, "2026-07-10", "jul-1");
    await order(f.machines.m2, f.titleId, "2026-05-10", "maj-1");
    // Appen började avräkna i juni (en avräkning på 0 kr räcker som första månad).
    await tx.execute(sql`insert into public.store_settlements
        (organization_id, store_id, month, amount_ore, statement, calc_version)
      values (${f.orgId}, ${f.stores.provision}, '2026-06-01', 0, '{}'::jsonb, 'test')`);
  });
  await asUser(f.ownerUser, (tx) =>
    tx.execute(sql`select public.close_period(${f.orgId}, '2026-07-01'::date)`),
  );
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

describe("äldre månader utan avräkning", () => {
  it("listas på Utbetalning, äldst först, och det som inte går att räkna står med sin månad", async () => {
    const older = await withUserDbFor(f.owner.user, (tx) =>
      queryOlderMissingSettlements(tx, f.orgId, "2026-10"),
    );
    // Maj ligger före första avräkningen (juni) och räknas inte. Juli är stängd men räknas:
    // en stängd månad får inte gömma att butiken saknar sina pengar. Augusti: bara Vinsten sålde.
    expect(older).toEqual([
      { month: "2026-07", storeIds: [f.stores.provision] },
      { month: "2026-08", storeIds: [f.stores.vinsten] },
      { month: "2026-09", storeIds: [f.stores.provision, f.stores.vinsten].sort() },
    ]);
    const page = await loadSettlementPageFor(f.owner, NOW);
    expect(page.month).toBe("2026-10");
    expect(page.missing.map((m) => `${m.month} ${m.storeName}`).sort()).toEqual([
      "2026-07 Provision",
      "2026-09 Provision",
      "2026-09 Vinsten",
      "2026-10 Provision",
      "2026-10 Vinsten",
    ]);
    expect(page.failed.map((x) => `${x.month} ${x.storeName}`)).toEqual(["2026-08 Vinsten"]);
  });

  it("knappen skapar också de äldre; den som inte går att räkna står kvar som fel", async () => {
    const run = await ensureSettlementsFor(f.owner, NOW);
    expect(run).toMatchObject({ created: 5, olderMonths: ["2026-07", "2026-09"] });
    expect(run!.errors).toHaveLength(1);
    expect(await months()).toEqual(["2026-06:1", "2026-07:1", "2026-09:2", "2026-10:2"]);
    // Juli är fortfarande stängd: avräkningen skapades utan att månaden öppnades.
    const july = await asPostgres((tx) =>
      one<{ amount_ore: string; closed: boolean }>(
        tx,
        sql`select s.amount_ore,
                   exists (select 1 from public.period_closes pc
                            where pc.organization_id = s.organization_id
                              and pc.month = s.month and pc.reopened_at is null) as closed
            from public.store_settlements s
            where s.organization_id = ${f.orgId} and s.month = '2026-07-01'`,
      ),
    );
    // 100 kr sålt, 10 % provision.
    expect(Number(july.amount_ore)).toBe(1_000);
    expect(july.closed).toBe(true);
    const page = await loadSettlementPageFor(f.owner, NOW);
    expect(page.missing).toEqual([]);
    expect(page.failed.map((x) => `${x.month} ${x.storeName}`)).toEqual(["2026-08 Vinsten"]);
  });

  it("när priset läggs in skapar det schemalagda jobbet augusti, också månader senare", async () => {
    // Priset gäller från 1 augusti: juli är stängd, och ett pris som når dit nekas (BL004).
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
                     values (${f.orgId}, ${unpricedTitle}, 4000, '2026-08-01')`),
    );
    const later = new Date("2027-02-03T10:00:00Z");
    vi.setSystemTime(later);
    const [run] = await createMonthlySettlements(db(), later, { organizationIds: [f.orgId] });
    expect(run!.errors).toEqual([]);
    expect(await months()).toContain("2026-08:1");
    // Månaden före första avräkningen (maj) får ingen.
    expect((await months()).some((m) => m.startsWith("2026-05"))).toBe(false);
    const aug = await asPostgres((tx) =>
      one<{ amount_ore: string }>(
        tx,
        sql`select amount_ore from public.store_settlements
            where organization_id = ${f.orgId} and month = '2026-08-01'`,
      ),
    );
    // Augusti: 100 kr sålt, 40 kr inköp → 30 kr till butiken.
    expect(Number(aug.amount_ore)).toBe(3_000);
  });
});

describe("en organisation som aldrig avräknat", () => {
  it("har inga äldre månader: bara förra månaden skapas, som förut", async () => {
    vi.setSystemTime(NOW);
    const g = await seedMoneyFixture("Aldrig avräknat");
    expect(
      await withUserDbFor(g.owner.user, (tx) =>
        queryOlderMissingSettlements(tx, g.orgId, "2026-10"),
      ),
    ).toEqual([]);
    const page = await loadSettlementPageFor(g.owner, NOW);
    expect(page.missing.map((m) => m.month)).toEqual(["2026-10", "2026-10"]);
  });
});
