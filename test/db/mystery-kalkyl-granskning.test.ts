/**
 * Granskning av Mystery-kalkylen och Prisråd mot testdatabasen:
 *
 * - samma siffror som Lönsamhet: med moms, kortavgift och en butik med provision är
 *   kalkylens och prisrådets vinst och marginal exakt Lönsamhetens (profitability per titel)
 *   FÖRE butikernas andel för samma dag,
 * - dubbeltryck: "Uppdatera priset från idag" och "Rätta priset" två gånger ger samma läge
 *   och inget fel (en prisrad, en loggrad),
 * - en titel i en annan organisation går inte att nå.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { profitability } from "../../src/domain";
import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { loadDomainInputFor, type Viewer } from "../../src/server/data/core/loaders";
import { loadPriceAdviceFor } from "../../src/app/(app)/lonsamhet/_lib/price-advice";
import { loadMysteryDetailFor } from "../../src/app/(app)/vart-lager/mystery/_lib/data";
import { mysteryCalc } from "../../src/app/(app)/vart-lager/mystery/_lib/model";
import {
  COST_MESSAGES,
  saveRecipeFor,
  updateMysteryCostFor,
} from "../../src/app/(app)/vart-lager/mystery/_lib/service";

import { asUser, createOrg, createUser, db, one, rows, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const session = (u: TestUser) => ({ userId: u.id, email: u.email });

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = session(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

function todayInStockholm(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe("Mystery-kalkylen och Prisråd: granskning", () => {
  let owner: TestUser;
  let other: TestUser;
  let orgId: string;
  let otherOrgId: string;
  let mystery: string;
  let partA: string;
  let partB: string;
  const today = todayInStockholm();

  const mysteryPrices = () =>
    rows<{ unit_cost_ore: number; valid_from: string }>(
      db(),
      sql`select unit_cost_ore::int, valid_from::text from public.purchase_prices
          where organization_id = ${orgId}::uuid and title_id = ${mystery}::uuid
          order by valid_from`,
    );
  const auditRows = async () =>
    (
      await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.audit_log
            where organization_id = ${orgId}::uuid and table_name = 'purchase_prices'
              and coalesce(after, before) ->> 'title_id' = ${mystery}`,
      )
    ).n;

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    other = await createUser();
    otherOrgId = await createOrg(other, "Annan organisation");

    await asUser(owner, async (tx) => {
      const org = { organizationId: orgId };
      // Moms 25 % och kortavgift 2,5 %: formlerna får något att räkna på.
      await tx.execute(
        sql`insert into public.organization_settings (organization_id, vat_rate_bp, card_fee_bp)
            values (${orgId}::uuid, 2500, 250)
            on conflict (organization_id) do update
              set vat_rate_bp = excluded.vat_rate_bp, card_fee_bp = excluded.card_fee_bp`,
      );
      const [store] = await tx
        .insert(s.stores)
        .values({ ...org, name: "ICA Granskning" })
        .returning();
      // Butiken får 20 % provision: den ska INTE synas i kalkylen eller prisrådet.
      await tx
        .insert(s.storeAgreements)
        .values({ ...org, storeId: store!.id, validFrom: "2020-01-01", commissionBp: 2000 });
      const [machine] = await tx
        .insert(s.machines)
        .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2020-01-01" })
        .returning();
      await tx
        .insert(s.machinePlacements)
        .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2020-01-01" });
      const titles = await tx
        .insert(s.titles)
        .values([
          { ...org, name: "Granskning Mystery", ownProduct: true },
          { ...org, name: "Granskning Del A" },
          { ...org, name: "Granskning Del B" },
        ])
        .returning();
      mystery = titles[0]!.id;
      partA = titles[1]!.id;
      partB = titles[2]!.id;
      await tx.insert(s.purchasePrices).values([
        { ...org, titleId: partA, unitCostOre: 10_000, validFrom: "2020-01-01" },
        { ...org, titleId: partB, unitCostOre: 13_337, validFrom: "2020-01-01" },
        { ...org, titleId: mystery, unitCostOre: 9_000, validFrom: "2020-01-01" },
      ]);
      const [source] = await tx
        .insert(s.dataSources)
        .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
        .returning();
      const sale = (ext: string, titleId: string, ore: number) =>
        tx.execute(
          sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title,
                title_id, ordered_at, amount_ore, machine_id, source_hash)
              values (${orgId}::uuid, ${source!.id}::uuid, ${ext}, 'x', ${titleId}::uuid,
                now() - interval '1 minute', ${ore}, ${machine!.id}::uuid, md5(${ext}))`,
        );
      await sale("g-1", mystery, 19_900);
      await sale("g-2", partA, 14_900);
    });
    await asUser(other, async (tx) => {
      await tx.insert(s.titles).values({ organizationId: otherOrgId, name: "Främmande" });
    });
    // 3 pack per omgång: 2 × 100 kr + 1 × 133,37 kr = 333,37 kr, 111,12 kr per pack.
    await saveRecipeFor(await viewerFor(owner, orgId), {
      titleId: mystery,
      batchSize: 3,
      items: [
        { titleId: partA, quantity: 2, hit: false },
        { titleId: partB, quantity: 1, hit: true },
      ],
    });
  });

  it("kalkylen räknar för hand: 333,37 kr per omgång, 111,12 kr per pack, vinst 43,10 kr", async () => {
    const detail = (await loadMysteryDetailFor(await viewerFor(owner, orgId), mystery))!;
    expect(detail.fees).toEqual({ vatRateBp: 2_500, cardFeeBp: 250 });
    const r = detail.title.recipe!;
    const calc = mysteryCalc(
      r.batchSize,
      r.items,
      Object.fromEntries(detail.overview.prices),
      detail.salePriceOre,
      detail.fees,
    );
    // 199 kr: moms 39,80, netto 159,20, kortavgift 4,98 (2,5 % av 199), kostnad 111,12.
    expect(calc).toMatchObject({
      perBatchOre: 33_337,
      perPackOre: 11_112,
      salePriceOre: 19_900,
      profitOre: 15_920 - 498 - 11_112,
      marginBp: 2_707,
    });
  });

  it("prisrådet är Lönsamhetens siffror före butikens andel (samma dag, dagens pris)", async () => {
    const viewer = await viewerFor(owner, orgId);
    const advice = await loadPriceAdviceFor(viewer);
    // Del A: 149 kr, netto 119,20, kortavgift 3,73, inköp 100: vinst 15,47 kr, 12,98 %.
    const a = advice.rows.find((x) => x.titleId === partA)!;
    expect(a).toMatchObject({ salePriceOre: 14_900, unitCostOre: 10_000, profitOre: 1_547 });
    const domain = await loadDomainInputFor(viewer, { period: { start: today, end: today } });
    const byTitle = profitability(domain.current, "title");
    const row = byTitle.rows.find((x) => x.key === partA)!;
    expect(row.commissionOre).toBeGreaterThan(0); // butiken har en andel …
    expect(row.profitOre).toBe(a.profitOre); // … men vinsten visas före den
    expect(row.marginBp).toBe(a.marginBp);
    // Förslaget når målet och är en prispunkt över dagens pris.
    // 0,8p − 0,025p − 100 ≥ 0,25 × 0,8p ger p ≥ 173,92 kr: närmaste prispunkt är 175 kr
    // (netto 140, kortavgift 4,38, vinst 35,62 kr = 25,44 %).
    expect(a.suggestedPriceOre).toBe(17_500);
    expect(a.suggestedMarginBp).toBe(2_544);
  });

  it("dubbeltryck på Uppdatera priset från idag: samma läge, inget fel, en loggrad", async () => {
    const viewer = await viewerFor(owner, orgId);
    const before = await auditRows();
    const input = { titleId: mystery, expectedOre: 11_112, mode: "today" as const };
    const first = await updateMysteryCostFor(viewer, input);
    const second = await updateMysteryCostFor(viewer, input);
    expect(second).toEqual(first);
    expect(await mysteryPrices()).toEqual([
      { unit_cost_ore: 9_000, valid_from: "2020-01-01" },
      { unit_cost_ore: 11_112, valid_from: today },
    ]);
    expect((await auditRows()) - before).toBe(1);
  });

  it("dubbeltryck på Rätta priset: samma läge, inget fel", async () => {
    const viewer = await viewerFor(owner, orgId);
    // En del blir dyrare: kalkylen är 121,12 kr.
    await asUser(owner, (tx) =>
      tx.execute(
        sql`update public.purchase_prices set unit_cost_ore = 11500
            where organization_id = ${orgId}::uuid and title_id = ${partA}::uuid`,
      ),
    );
    const input = { titleId: mystery, expectedOre: 12_112, mode: "correct" as const };
    const first = await updateMysteryCostFor(viewer, input);
    expect(first).toMatchObject({ unitCostOre: 12_112, mode: "correct", affectedOrders: 1 });
    const second = await updateMysteryCostFor(viewer, input);
    expect(second).toMatchObject({ unitCostOre: 12_112, mode: "correct", affectedOrders: 0 });
    expect((await mysteryPrices()).map((p) => p.unit_cost_ore)).toEqual([12_112, 12_112]);
  });

  it("en titel i en annan organisation går inte att nå", async () => {
    const foreign = await one<{ id: string }>(
      db(),
      sql`select id::text from public.titles where organization_id = ${otherOrgId}::uuid limit 1`,
    );
    const error = await failure(
      updateMysteryCostFor(await viewerFor(owner, orgId), {
        titleId: foreign.id,
        expectedOre: 100,
        mode: "today",
      }),
    );
    expect((error as Error).message).toBe(COST_MESSAGES.noRecipe);
    const mine = await failure(
      updateMysteryCostFor(await viewerFor(other, otherOrgId), {
        titleId: mystery,
        expectedOre: 12_112,
        mode: "correct",
      }),
    );
    expect((mine as Error).message).toBe(COST_MESSAGES.noRecipe);
    expect((await mysteryPrices()).map((p) => p.unit_cost_ore)).toEqual([12_112, 12_112]);
  });

  it("en del till byter pris samma dag: dagens pris ersätts, det äldre ligger kvar", async () => {
    const viewer = await viewerFor(owner, orgId);
    // Del B: 133,37 → 140 kr. Kalkylen: (2 × 115 + 140) / 3 = 123,33 kr.
    await asUser(owner, (tx) =>
      tx.execute(
        sql`update public.purchase_prices set unit_cost_ore = 14000
            where organization_id = ${orgId}::uuid and title_id = ${partB}::uuid`,
      ),
    );
    const detail = (await loadMysteryDetailFor(viewer, mystery))!;
    expect(detail.title.currentCostOre).toBe(12_112);
    const result = await updateMysteryCostFor(viewer, {
      titleId: mystery,
      expectedOre: 12_333,
      mode: "today",
    });
    expect(result).toMatchObject({ unitCostOre: 12_333, mode: "today", validFrom: today });
    // Fortfarande två rader: den från 2020 är orörd, dagens har det nya beloppet.
    expect(await mysteryPrices()).toEqual([
      { unit_cost_ore: 12_112, valid_from: "2020-01-01" },
      { unit_cost_ore: 12_333, valid_from: today },
    ]);
    // Det gamla beloppet från i dag finns kvar i loggen (inget försvinner spårlöst).
    const logged = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log
          where organization_id = ${orgId}::uuid and table_name = 'purchase_prices'
            and before ->> 'title_id' = ${mystery} and before ->> 'unit_cost_ore' = '12112'
            and after ->> 'unit_cost_ore' = '12333'`,
    );
    expect(logged.n).toBe(1);
  });
});
