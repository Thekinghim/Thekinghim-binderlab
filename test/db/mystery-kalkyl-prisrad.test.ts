/**
 * Mystery-kalkylen och Prisråd mot testdatabasen (20261120000000_prisrad.sql):
 *
 * Mystery-kalkylen
 * - en del byter pris (Fusion Strike 133 → 220 kr): mystery-packets eget inköpspris stämmer
 *   inte längre med kalkylen. Notisen (loadMysteryCostDriftsFor) och punkten i Att göra
 *   säger "kostar nu 213 kr, inte 174 kr"; påfyllaren får ingen sådan punkt,
 * - "Uppdatera priset från i dag": beloppet räknas på servern, ett nytt pris från i dag;
 *   det gamla priset och all tidigare försäljning ligger kvar orörda (historiken skrivs
 *   aldrig om tyst); en inaktuell sida nekas och inget skrivs,
 * - "Rätta priset": först då får även gamla perioder det nya priset,
 * - roller: bara ägare och admin (även delägaren i Enkel vy); läsaren ser notisen men
 *   ändrar inget; påfyllaren och en annan organisation når ingenting.
 *
 * Prisråd
 * - målet är 25 % som standard; produkter under målet med pris, inköp, marginal och förslag,
 * - ägare och admin ändrar målet (1–90 %), läsaren och påfyllaren nekas även direkt i SQL,
 *   ändringen loggas, och Att göra får EN punkt "2 produkter tjänar för lite".
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";
import { loadTodosFor, type Viewer } from "../../src/server/data/core/loaders";
import { addPurchasePriceFor } from "../../src/app/(app)/inkopspriser/_lib/data";
import {
  loadPriceAdviceFor,
  setTargetMarginFor,
} from "../../src/app/(app)/lonsamhet/_lib/price-advice";
import {
  loadMysteryCostDriftsFor,
  loadMysteryDetailFor,
} from "../../src/app/(app)/vart-lager/mystery/_lib/data";
import { mysteryCalc } from "../../src/app/(app)/vart-lager/mystery/_lib/model";
import {
  COST_MESSAGES,
  MysteryError,
  saveRecipeFor,
  updateMysteryCostFor,
} from "../../src/app/(app)/vart-lager/mystery/_lib/service";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const session = (u: TestUser) => ({ userId: u.id, email: u.email });

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = session(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

/** Dagens datum i Stockholm (organisationens tidszon). */
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

describe("Mystery-kalkylen och Prisråd", () => {
  let owner: TestUser;
  let admin: TestUser;
  let partner: TestUser; // delägaren: ägarroll med Enkel vy
  let refiller: TestUser;
  let reader: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let premium: string;
  const t: Record<string, string> = {};
  const today = todayInStockholm();

  const premiumPrices = () =>
    rows<{ unit_cost_ore: number; valid_from: string }>(
      db(),
      sql`select unit_cost_ore::int, valid_from::text from public.purchase_prices
          where organization_id = ${orgId}::uuid and title_id = ${premium}::uuid
          order by valid_from`,
    );
  const setPrice = async (titleId: string, unitCostOre: number) => {
    const res = await addPurchasePriceFor(session(owner), {
      organizationId: orgId,
      titleId,
      unitCostOre,
      validFrom: today,
    });
    expect(res.ok, res.error).toBe(true);
  };
  const todos = async (u: TestUser) => loadTodosFor(await viewerFor(u, orgId));

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    admin = await createMember(orgId, "admin");
    partner = await createMember(orgId, "owner");
    refiller = await createMember(orgId, "refiller");
    reader = await createMember(orgId, "viewer");
    outsider = await createUser();
    await createOrg(outsider, "Annan organisation");
    await db().execute(
      sql`update public.memberships set view_mode = 'simple'
          where organization_id = ${orgId}::uuid and user_id = ${partner.id}::uuid`,
    );

    await asUser(owner, async (tx) => {
      const org = { organizationId: orgId };
      const titles = await tx
        .insert(s.titles)
        .values([
          { ...org, name: "Mystery pack premium", ownProduct: true },
          { ...org, name: "Fusion Strike" },
          { ...org, name: "30th Celebration" },
          { ...org, name: "Phantasmal Flames" },
          { ...org, name: "Prismatic Evolution" },
          { ...org, name: "Ascended Heroes" },
          { ...org, name: "Hit" },
        ])
        .returning();
      premium = titles[0]!.id;
      for (const [i, key] of [
        "fusion",
        "celebration",
        "flames",
        "prismatic",
        "heroes",
        "hit",
      ].entries()) {
        t[key] = titles[i + 1]!.id;
      }
      const from = "2020-01-01";
      await tx.insert(s.purchasePrices).values([
        // Fusion Strike står fel (133 kr); mystery-packets pris är inskrivet för hand.
        { ...org, titleId: t.fusion!, unitCostOre: 13_300, validFrom: from },
        { ...org, titleId: t.celebration!, unitCostOre: 25_000, validFrom: from },
        { ...org, titleId: t.flames!, unitCostOre: 15_000, validFrom: from },
        { ...org, titleId: t.prismatic!, unitCostOre: 30_000, validFrom: from },
        { ...org, titleId: t.heroes!, unitCostOre: 20_000, validFrom: from },
        { ...org, titleId: t.hit!, unitCostOre: 25_200, validFrom: from },
        { ...org, titleId: premium, unitCostOre: 17_400, validFrom: from },
      ]);
      const [machine] = await tx
        .insert(s.machines)
        .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2020-01-01" })
        .returning();
      const [source] = await tx
        .insert(s.dataSources)
        .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
        .returning();
      // Sålt: mystery packs för 299 kr (två för 20 dagar sedan, ett i går), Fusion Strike
      // för 249 kr och 30th Celebration för 399 kr i går.
      const sale = (ext: string, name: string, titleId: string, daysAgo: number, ore: number) =>
        tx.execute(
          sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title,
                title_id, ordered_at, amount_ore, machine_id, source_hash)
              values (${orgId}::uuid, ${source!.id}::uuid, ${ext}, ${name}, ${titleId}::uuid,
                now() - make_interval(days => ${daysAgo}), ${ore}, ${machine!.id}::uuid,
                md5(${ext}))`,
        );
      await sale("k-1", "Mystery pack premium", premium, 20, 29_900);
      await sale("k-2", "Mystery pack premium", premium, 20, 29_900);
      await sale("k-3", "Mystery pack premium", premium, 1, 29_900);
      await sale("k-4", "Fusion Strike", t.fusion!, 1, 24_900);
      await sale("k-5", "30th Celebration", t.celebration!, 1, 39_900);
    });

    // Ägarens recept: 14 per omgång.
    await saveRecipeFor(await viewerFor(owner, orgId), {
      titleId: premium,
      batchSize: 14,
      items: [
        { titleId: t.fusion!, quantity: 4, hit: false },
        { titleId: t.celebration!, quantity: 3, hit: false },
        { titleId: t.flames!, quantity: 4, hit: false },
        { titleId: t.prismatic!, quantity: 1, hit: false },
        { titleId: t.heroes!, quantity: 1, hit: false },
        { titleId: t.hit!, quantity: 1, hit: true },
      ],
    });
  });

  describe("mystery-kalkylen", () => {
    it("Fusion Strike rättas till 220 kr: notisen och Att göra säger 213 kr, inte 174 kr", async () => {
      await setPrice(t.fusion!, 22_000);
      const drifts = await loadMysteryCostDriftsFor(await viewerFor(owner, orgId));
      expect(drifts).toEqual([
        {
          titleId: premium,
          name: "Mystery pack premium",
          currentOre: 17_400,
          calculatedOre: 21_300,
        },
      ]);
      const item = (await todos(owner)).find((x) => x.kind === "mystery-cost");
      expect(item).toMatchObject({
        key: `mystery-cost:${premium}`,
        title: "Mystery pack premium kostar nu 213\u00a0kr, inte 174\u00a0kr",
        link: `/vart-lager/mystery/${premium}#kalkyl`,
      });
      // Inget har skrivits om: mystery-packets pris är kvar.
      expect(await premiumPrices()).toEqual([{ unit_cost_ore: 17_400, valid_from: "2020-01-01" }]);
    });

    it("kalkylen på sidan: kostnad per omgång och pack, pris, vinst och marginal", async () => {
      const detail = (await loadMysteryDetailFor(await viewerFor(owner, orgId), premium))!;
      expect(detail.salePriceOre).toBe(29_900);
      expect(detail.fees).toEqual({ vatRateBp: 0, cardFeeBp: 0 });
      const recipe = detail.title.recipe!;
      const calc = mysteryCalc(
        recipe.batchSize,
        recipe.items,
        Object.fromEntries(detail.overview.prices),
        detail.salePriceOre,
        detail.fees,
      );
      expect(calc).toMatchObject({
        perBatchOre: 298_200,
        perPackOre: 21_300,
        profitOre: 8_600,
        marginBp: 2_876,
      });
      expect(detail.title.currentCostOre).toBe(17_400);
    });

    it("läsaren ser notisen; påfyllaren får varken notis eller punkt; utomstående nekas", async () => {
      expect(await loadMysteryCostDriftsFor(await viewerFor(reader, orgId))).toHaveLength(1);
      expect(await loadMysteryCostDriftsFor(await viewerFor(refiller, orgId))).toEqual([]);
      const kinds = (await todos(refiller)).map((x) => x.kind);
      expect(kinds).not.toContain("mystery-cost");
      expect(kinds).not.toContain("price-advice");
      // En utomstående med påhittat medlemskap i organisationen: rollen kontrolleras i databasen.
      const fake: Viewer = {
        user: session(outsider),
        organization: (await viewerFor(owner, orgId)).organization,
      };
      expect(await failure(loadMysteryCostDriftsFor(fake))).toBeInstanceOf(AuthorizationError);
      expect(
        await failure(
          updateMysteryCostFor(fake, { titleId: premium, expectedOre: 21_300, mode: "today" }),
        ),
      ).toBeInstanceOf(AuthorizationError);
    });

    it("läsaren och påfyllaren får inte uppdatera priset, och inget skrivs", async () => {
      for (const u of [reader, refiller]) {
        const error = await failure(
          updateMysteryCostFor(await viewerFor(u, orgId), {
            titleId: premium,
            expectedOre: 21_300,
            mode: "today",
          }),
        );
        expect(error).toBeInstanceOf(AuthorizationError);
      }
      expect(await premiumPrices()).toHaveLength(1);
    });

    it("en inaktuell sida nekas: beloppet räknas på servern, aldrig från klienten", async () => {
      const error = await failure(
        updateMysteryCostFor(await viewerFor(owner, orgId), {
          titleId: premium,
          expectedOre: 100,
          mode: "today",
        }),
      );
      expect(error).toBeInstanceOf(MysteryError);
      expect((error as Error).message).toBe(COST_MESSAGES.changed);
      // En titel utan innehåll går inte heller.
      const none = await failure(
        updateMysteryCostFor(await viewerFor(owner, orgId), {
          titleId: t.fusion!,
          expectedOre: 22_000,
          mode: "today",
        }),
      );
      expect((none as Error).message).toBe(COST_MESSAGES.noRecipe);
      expect(await premiumPrices()).toHaveLength(1);
    });

    it("Uppdatera priset från i dag: nytt pris i dag, det gamla priset ligger kvar", async () => {
      const res = await updateMysteryCostFor(await viewerFor(admin, orgId), {
        titleId: premium,
        expectedOre: 21_300,
        mode: "today",
      });
      expect(res).toEqual({
        unitCostOre: 21_300,
        mode: "today",
        validFrom: today,
        affectedOrders: 0,
      });
      expect(await premiumPrices()).toEqual([
        { unit_cost_ore: 17_400, valid_from: "2020-01-01" },
        { unit_cost_ore: 21_300, valid_from: today },
      ]);
      // Notisen och punkten är borta.
      expect(await loadMysteryCostDriftsFor(await viewerFor(owner, orgId))).toEqual([]);
      expect((await todos(owner)).some((x) => x.kind === "mystery-cost")).toBe(false);
      // Ändringen är loggad.
      const log = await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.audit_log
            where organization_id = ${orgId}::uuid and table_name = 'purchase_prices'
              and after ->> 'title_id' = ${premium} and actor_id = ${admin.id}::uuid`,
      );
      expect(log.n).toBe(1);
    });

    it("delägaren i Enkel vy ser notisen igen när innehållet ändras, och väljer Rätta priset", async () => {
      // Receptet ändras: en Fusion Strike byts mot en Phantasmal Flames (70 kr billigare omgång).
      await saveRecipeFor(await viewerFor(owner, orgId), {
        titleId: premium,
        batchSize: 14,
        items: [
          { titleId: t.fusion!, quantity: 3, hit: false },
          { titleId: t.celebration!, quantity: 3, hit: false },
          { titleId: t.flames!, quantity: 5, hit: false },
          { titleId: t.prismatic!, quantity: 1, hit: false },
          { titleId: t.heroes!, quantity: 1, hit: false },
          { titleId: t.hit!, quantity: 1, hit: true },
        ],
      });
      const v = await viewerFor(partner, orgId);
      expect(v.organization.viewMode).toBe("simple");
      expect(await loadMysteryCostDriftsFor(v)).toEqual([
        {
          titleId: premium,
          name: "Mystery pack premium",
          currentOre: 21_300,
          calculatedOre: 20_800,
        },
      ]);
      const res = await updateMysteryCostFor(v, {
        titleId: premium,
        expectedOre: 20_800,
        mode: "correct",
      });
      expect(res).toMatchObject({ unitCostOre: 20_800, mode: "correct", affectedOrders: 3 });
      // Först nu, efter ägarens val, har även gamla perioder det nya priset.
      const after = await premiumPrices();
      expect(after.map((p) => p.unit_cost_ore)).toEqual([20_800, 20_800]);
      expect(await loadMysteryCostDriftsFor(v)).toEqual([]);
    });
  });

  describe("prisråd", () => {
    it("standardmålet 25 %: Fusion Strike tjänar för lite, med pris, inköp och förslag", async () => {
      const advice = await loadPriceAdviceFor(await viewerFor(owner, orgId));
      expect(advice.targetBp).toBe(2_500);
      expect(advice.rows).toEqual([
        {
          titleId: t.fusion,
          name: "Fusion Strike",
          salePriceOre: 24_900,
          lowestIn: null,
          where: null,
          unitCostOre: 22_000,
          profitOre: 2_900,
          marginBp: 1_165,
          suggestedPriceOre: 29_500,
          suggestedMarginBp: 2_542,
        },
      ]);
      const item = (await todos(owner)).find((x) => x.kind === "price-advice");
      expect(item).toMatchObject({
        title: "1\u00a0produkt tjänar för lite",
        link: "/lonsamhet#prisrad",
      });
    });

    it("läsaren läser råden; påfyllaren nekas", async () => {
      expect((await loadPriceAdviceFor(await viewerFor(reader, orgId))).rows).toHaveLength(1);
      expect(await failure(loadPriceAdviceFor(await viewerFor(refiller, orgId)))).toBeInstanceOf(
        AuthorizationError,
      );
    });

    it("bara ägare och admin ändrar målet; 1–90 %; ändringen loggas", async () => {
      for (const u of [reader, refiller]) {
        const res = await setTargetMarginFor(await viewerFor(u, orgId), { targetMarginBp: 4_000 });
        expect(res.ok).toBe(false);
      }
      const o = await viewerFor(owner, orgId);
      for (const bad of [0, 50, 9_100, 2_500.5, Number.NaN]) {
        expect((await setTargetMarginFor(o, { targetMarginBp: bad })).ok, String(bad)).toBe(false);
      }
      expect((await loadPriceAdviceFor(o)).targetBp).toBe(2_500);

      // Mystery-packet tjänar 30,4 % (299 kr, kostar 208 kr): under 35 % men över 25 %.
      expect(await setTargetMarginFor(o, { targetMarginBp: 3_500 })).toEqual({
        ok: true,
        data: { targetMarginBp: 3_500 },
      });
      const advice = await loadPriceAdviceFor(o);
      expect(advice.targetBp).toBe(3_500);
      expect(advice.rows.map((r) => r.name)).toEqual(["Fusion Strike", "Mystery pack premium"]);
      expect(advice.rows[1]).toMatchObject({
        salePriceOre: 29_900,
        unitCostOre: 20_800,
        marginBp: 3_043,
        suggestedPriceOre: 32_500,
      });
      expect((await todos(owner)).find((x) => x.kind === "price-advice")?.title).toBe(
        "2\u00a0produkter tjänar för lite",
      );
      const log = await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.audit_log
            where organization_id = ${orgId}::uuid and table_name = 'organization_settings'
              and (after ->> 'target_margin_bp')::int = 3500`,
      );
      expect(log.n).toBe(1);

      // Admin får också; samma värde igen ger ingen ny loggrad.
      const a = await viewerFor(admin, orgId);
      expect((await setTargetMarginFor(a, { targetMarginBp: 3_500 })).ok).toBe(true);
      expect((await setTargetMarginFor(a, { targetMarginBp: 2_500 })).ok).toBe(true);
      expect((await loadPriceAdviceFor(o)).rows).toHaveLength(1);
    });

    it("databasen: läsaren och påfyllaren kan inte ändra målet direkt, och gränserna hålls", async () => {
      for (const u of [reader, refiller, outsider]) {
        const outcome = await asUser(u, (tx) =>
          attempt(tx, (sp) =>
            sp.execute(
              sql`update public.organization_settings set target_margin_bp = 9000
                  where organization_id = ${orgId}::uuid returning id`,
            ),
          ),
        );
        // RLS: inga rader träffas (eller nekas), målet är kvar.
        expect(outcome.ok ? Array.from(outcome.value as Iterable<unknown>).length : 0).toBe(0);
      }
      const bad = await asUser(owner, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`update public.organization_settings set target_margin_bp = 9500
                where organization_id = ${orgId}::uuid`,
          ),
        ),
      );
      expect(bad).toMatchObject({ ok: false, code: "23514" });
      const row = await one<{ bp: number }>(
        db(),
        sql`select target_margin_bp::int as bp from public.organization_settings
            where organization_id = ${orgId}::uuid`,
      );
      expect(row.bp).toBe(2_500);
    });
  });

  describe("efter granskningen av release 8", () => {
    let budget: string;
    let m1: string;
    let m2: string;
    let sourceId: string;
    const sale = (ext: string, titleId: string, machineId: string, daysAgo: number, ore: number) =>
      db().execute(
        sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title,
              title_id, ordered_at, amount_ore, machine_id, source_hash)
            values (${orgId}::uuid, ${sourceId}::uuid, ${ext}, 'x', ${titleId}::uuid,
              now() - make_interval(days => ${daysAgo}), ${ore}, ${machineId}::uuid, md5(${ext}))`,
      );

    beforeAll(async () => {
      const ids = await asUser(owner, async (tx) => {
        const [title] = await tx
          .insert(s.titles)
          .values({ organizationId: orgId, name: "Mystery pack budget", ownProduct: true })
          .returning();
        const [machine] = await tx
          .insert(s.machines)
          .values({
            organizationId: orgId,
            code: "BL-002",
            name: "Automat 2",
            activeFrom: "2020-01-01",
          })
          .returning();
        return { budget: title!.id, m2: machine!.id };
      });
      budget = ids.budget;
      m2 = ids.m2;
      m1 = (
        await one<{ id: string }>(
          db(),
          sql`select id from public.machines where organization_id = ${orgId}::uuid and code = 'BL-001'`,
        )
      ).id;
      sourceId = (
        await one<{ id: string }>(
          db(),
          sql`select id from public.data_sources where organization_id = ${orgId}::uuid limit 1`,
        )
      ).id;
      // 10 Phantasmal Flames à 150 kr och 4 Ascended Heroes à 200 kr: 2 300 kr / 14 = 164,29 kr.
      await saveRecipeFor(await viewerFor(owner, orgId), {
        titleId: budget,
        batchSize: 14,
        items: [
          { titleId: t.flames!, quantity: 10, hit: false },
          { titleId: t.heroes!, quantity: 4, hit: true },
        ],
      });
      // Sålt utan inköpspris: två i BL-001 för 249 kr (15 dagar sedan och i går).
      await sale("b-1", budget, m1, 15, 24_900);
      await sale("b-2", budget, m1, 1, 24_900);
    });

    it("sålt mystery pack utan inköpspris: EN punkt i Att göra, inte två", async () => {
      const mine = (await todos(owner)).filter((x) => x.evidence.titleIds.includes(budget));
      expect(mine.map((x) => x.kind)).toEqual(["mystery-cost"]);
      expect(mine[0]!.title.replace(/\u00a0/g, " ")).toBe(
        "Mystery pack budget kostar 164,29 kr men saknar inköpspris",
      );
      // Admin ser samma enda punkt.
      const admins = (await todos(admin)).filter((x) => x.evidence.titleIds.includes(budget));
      expect(admins.map((x) => x.kind)).toEqual(["mystery-cost"]);
    });

    it("'Lägg in priset' ger även de sålda packen ett pris, och punkterna försvinner", async () => {
      const v = await viewerFor(owner, orgId);
      const res = await updateMysteryCostFor(v, {
        titleId: budget,
        expectedOre: 16_429,
        mode: "correct",
      });
      expect(res).toMatchObject({ unitCostOre: 16_429, mode: "correct", affectedOrders: 2 });
      // Ett pris, från den första sålda dagen (inte från i dag).
      const prices = await rows<{ unit_cost_ore: number; valid_from: string }>(
        db(),
        sql`select unit_cost_ore::int, valid_from::text from public.purchase_prices
            where organization_id = ${orgId}::uuid and title_id = ${budget}::uuid`,
      );
      expect(prices).toHaveLength(1);
      expect(prices[0]!.unit_cost_ore).toBe(16_429);
      expect(prices[0]!.valid_from < today).toBe(true);
      const left = (await todos(owner)).filter(
        (x) =>
          x.evidence.titleIds.includes(budget) &&
          (x.kind === "mystery-cost" || x.kind === "missing-price"),
      );
      expect(left).toEqual([]);
      // Ett andra tryck (dubbeltryck) är inget fel.
      expect(
        await updateMysteryCostFor(v, { titleId: budget, expectedOre: 16_429, mode: "correct" }),
      ).toMatchObject({ mode: "correct", affectedOrders: 0 });
    });

    it("olika pris i automaterna: Prisråd och kalkylen visar samma pris och säger var", async () => {
      // BL-002 säljer samma pack för 199 kr (3 dagar sedan); BL-001 för 249 kr i går.
      await sale("b-3", budget, m2, 3, 19_900);
      const v = await viewerFor(owner, orgId);
      const row = (await loadPriceAdviceFor(v)).rows.find((r) => r.titleId === budget);
      expect(row).toMatchObject({ salePriceOre: 19_900, unitCostOre: 16_429 });
      expect(row!.where?.code).toBe("BL-002");
      expect(row!.where!.soldOn < today).toBe(true);
      const detail = await loadMysteryDetailFor(v, budget);
      expect(detail).toMatchObject({ salePriceOre: 19_900, salePriceMachine: "BL-002" });
      // Premium säljs bara i en automat: inget att peka ut.
      expect(await loadMysteryDetailFor(v, premium)).toMatchObject({
        salePriceOre: 29_900,
        salePriceMachine: null,
      });
      // När BL-002 också säljer för 249 kr är priserna lika igen.
      await sale("b-4", budget, m2, 0, 24_900);
      expect(await loadMysteryDetailFor(v, budget)).toMatchObject({
        salePriceOre: 24_900,
        salePriceMachine: null,
      });
      const again = (await loadPriceAdviceFor(v)).rows.find((r) => r.titleId === budget);
      expect(again?.where ?? null).toBeNull();
    });
  });
});
