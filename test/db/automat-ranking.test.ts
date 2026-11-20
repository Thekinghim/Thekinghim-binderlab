/**
 * Automat-ranking och Bästa sortiment mot testdatabasen, med sidladdarna för en given
 * användare (viewerPageLoaders: rollen ur databasen, allt under RLS).
 *
 * - En automat: jämförs med sin egen förra period, och det som står still visas utan förslag.
 * - Tio automater: rangordning med omdömen mot medianen, och förslag från andra automater.
 * - Inga N+1-frågor: lika många rundresor till databasen med 1 som med 10 automater.
 * - Påfyllaren får ingenting, läsaren får läsa, en annan organisation syns aldrig.
 * - Vyknappen "Visa butikernas andel" sänker vinsten per dag; utan den är vinsten före andelen.
 */

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  loadBestAssortmentWith,
  loadFleetRankingWith,
} from "@/app/(app)/automater/_lib/ranking-data";
import * as s from "@/db/schema";
import { addDays, type IsoDate } from "@/domain";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { viewerPageLoaders } from "@/server/data/page-loaders";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  uniqueSuffix,
  type TestUser,
} from "./helpers";
import { installRoundTripCounter, type RoundTripCounter } from "./round-trips";

vi.mock("server-only", () => ({}));

const NOW = new Date("2025-06-30T09:00:00Z");
const FIRST: IsoDate = "2025-04-21";
const LAST: IsoDate = "2025-06-29";
const SP = { period: "30d" };

interface Fleet {
  readonly orgId: string;
  readonly owner: TestUser;
  readonly machineIds: string[];
  readonly titles: Record<"a" | "flair" | "c" | "d" | "e", string>;
}

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const loaders = (viewer: Viewer, storeShare = false) =>
  viewerPageLoaders(viewer, { now: NOW, storeShare });

/**
 * En organisation med `n` automater i var sin butik (20 % provision). Automat i säljer
 * i + 1 pack Pokémon 151 per dag i 70 dagar. Automat 0 har dessutom White Flair (1 pack på
 * hela tiden), Surging Sparks och Prismatic (1 per dag). De andra har 30th Celebration
 * (2 per dag), som automat 0 saknar.
 */
async function seedFleet(n: number): Promise<Fleet> {
  const owner = await createUser(`rank-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Rank ${uniqueSuffix()}`);
  const org = { organizationId: orgId };
  return asUser(owner, async (tx) => {
    const titleRows = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Pokémon 151" },
        { ...org, name: "White Flair" },
        { ...org, name: "Surging Sparks" },
        { ...org, name: "Prismatic Evolutions" },
        { ...org, name: "30th Celebration" },
      ])
      .returning();
    const [a, flair, c, d, e] = titleRows.map((t) => t.id) as [
      string,
      string,
      string,
      string,
      string,
    ];
    await tx.insert(s.purchasePrices).values(
      [a, flair, c, d, e].map((titleId) => ({
        ...org,
        titleId,
        unitCostOre: 4_000,
        validFrom: "2025-01-01",
      })),
    );
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const machineIds: string[] = [];
    let seq = 0;
    for (let i = 0; i < n; i++) {
      const [store] = await tx
        .insert(s.stores)
        .values({ ...org, name: `Butik ${i + 1}` })
        .returning();
      await tx
        .insert(s.storeAgreements)
        .values({ ...org, storeId: store!.id, validFrom: "2025-01-01", commissionBp: 2000 });
      const [machine] = await tx
        .insert(s.machines)
        .values({
          ...org,
          code: `BL-${String(i + 1).padStart(3, "0")}`,
          name: `Automat ${i + 1}`,
          activeFrom: "2025-01-01",
        })
        .returning();
      const machineId = machine!.id;
      machineIds.push(machineId);
      await tx
        .insert(s.machinePlacements)
        .values({ ...org, machineId, storeId: store!.id, validFrom: "2025-01-01" });
      const perDay: Array<[string, number]> =
        i === 0
          ? [
              [a, 1],
              [c, 1],
              [d, 1],
            ]
          : [
              [a, i + 1],
              [e, 2],
            ];
      await tx.insert(s.machineSlots).values(
        [...perDay.map(([t]) => t), ...(i === 0 ? [flair] : [])].map((titleId) => ({
          ...org,
          machineId,
          titleId,
          slots: 1,
          validFrom: "2025-01-01",
        })),
      );
      const orders = [];
      const order = (titleId: string, day: IsoDate, k: number) => ({
        ...org,
        dataSourceId: source!.id,
        machineId,
        paymentMethod: "card",
        externalId: `o-${++seq}`,
        rawTitle: "x",
        titleId,
        orderedAt: new Date(`${day}T${String(8 + (k % 10)).padStart(2, "0")}:00:00Z`),
        amountOre: 10_000,
        sourceHash: `h-${seq}`,
      });
      for (let day = FIRST; day <= LAST; day = addDays(day, 1)) {
        for (const [titleId, count] of perDay) {
          for (let k = 0; k < count; k++) orders.push(order(titleId, day, k));
        }
      }
      if (i === 0) orders.push(order(flair, "2025-06-10", 0));
      for (let at = 0; at < orders.length; at += 500) {
        await tx.insert(s.orders).values(orders.slice(at, at + 500));
      }
    }
    return { orgId, owner, machineIds, titles: { a, flair, c, d, e } };
  });
}

let one: Fleet;
let ten: Fleet;
let oneOwner: Viewer;
let tenOwner: Viewer;

beforeAll(async () => {
  one = await seedFleet(1);
  ten = await seedFleet(10);
  oneOwner = await viewerFor(one.owner, one.orgId);
  tenOwner = await viewerFor(ten.owner, ten.orgId);
}, 180_000);

describe("Automat-ranking", () => {
  it("en automat: jämförs med sin förra period i stället för en tom rangordning", async () => {
    const data = await loadFleetRankingWith(loaders(oneOwner), SP);
    expect(data.ranking.mode).toBe("single");
    // 30 d t.o.m. i dag, hela dagar: 1–29 juni.
    expect(data.period).toEqual({ start: "2025-06-01", end: "2025-06-29" });
    expect(data.previous).toEqual({ start: "2025-05-03", end: "2025-05-31" });
    const row = data.ranking.rows[0]!;
    expect(row.machineId).toBe(one.machineIds[0]);
    expect(row.activeDays).toBe(29);
    expect(row.unitsPerDayTenths).toBe(30);
    expect(row.verdict).toBe("same");
    expect(row.previousProfitPerDayOre).toBeGreaterThan(0);
    expect(data.storeShareDeducted).toBe(false);
    expect(data.lostKnown).toBe(true);
  });

  it("tio automater: rangordnade efter vinst per dag med omdöme mot medianen", async () => {
    const data = await loadFleetRankingWith(loaders(tenOwner), SP);
    const r = data.ranking;
    expect(r.mode).toBe("fleet");
    expect(r.rows).toHaveLength(10);
    // Automat 10 säljer mest.
    expect(r.rows[0]!.machineId).toBe(ten.machineIds[9]);
    expect(r.rows[0]!.verdict).toBe("best");
    expect(r.best?.machineId).toBe(ten.machineIds[9]);
    const profits = r.rows.map((x) => x.profitPerDayOre);
    expect([...profits].sort((x, y) => y - x)).toEqual(profits);
    // Räknat för hand: 100 kr per pack − 40 kr inköp = 60 kr, ingen moms eller kortavgift här.
    // Automat 10: 10 + 2 pack per dag = 720 kr/dag. Automat 1: 3 per dag i 29 dagar + 1 White
    // Flair = 88 pack × 60 kr / 29 dagar = 182,07 kr/dag. Automat 2–10: 240, 300 … 720 kr/dag.
    // Medianen av tio: (420 + 480) / 2 = 450 kr/dag.
    expect(r.rows[0]).toMatchObject({
      profitPerDayOre: 72_000,
      revenuePerDayOre: 120_000,
      unitsPerDayTenths: 120,
      activeDays: 29,
      vsMedianOre: 27_000,
    });
    expect(r.rows[9]).toMatchObject({
      machineId: ten.machineIds[0],
      profitPerDayOre: 18_207,
      vsMedianOre: 18_207 - 45_000,
    });
    expect(r.rows.map((x) => x.profitPerDayOre).slice(1, 9)).toEqual([
      66_000, 60_000, 54_000, 48_000, 42_000, 36_000, 30_000, 24_000,
    ]);
    expect(r.medianProfitPerDayOre).toBe(45_000);
    // Automat 1 säljer 3 pack per dag; medianen är 7,5: bara den ligger under hälften.
    expect(r.weak.map((x) => x.machineId)).toEqual([ten.machineIds[0]]);
    expect(r.rows.filter((x) => x.verdict === "good")).toHaveLength(8);
    expect(data.machines.get(ten.machineIds[9]!)).toMatchObject({ code: "BL-010" });
  });

  it("vinsten är före butikernas andel; med vyknappen dras andelen", async () => {
    const before = await loadFleetRankingWith(loaders(tenOwner, false), SP);
    const after = await loadFleetRankingWith(loaders(tenOwner, true), SP);
    expect(before.storeShareDeducted).toBe(false);
    expect(after.storeShareDeducted).toBe(true);
    const top = (d: typeof before) =>
      d.ranking.rows.find((x) => x.machineId === ten.machineIds[9])!.profitPerDayOre;
    // Före andelen 720 kr/dag. Butiken har 20 % av 100 kr = 20 kr per pack: 12 × 40 = 480 kr/dag.
    expect(top(before)).toBe(72_000);
    expect(top(after)).toBe(48_000);
  });

  it("butiksfiltret visar bara butikens automat (och drar butikens andel)", async () => {
    const all = await loadFleetRankingWith(loaders(tenOwner), SP);
    const storeId = (await loaders(tenOwner).masterData()).machines.find(
      (m) => m.id === ten.machineIds[4],
    )!.storeId!;
    const scoped = await loadFleetRankingWith(loaders(tenOwner), { ...SP, butik: storeId });
    expect(scoped.ranking.rows.map((x) => x.machineId)).toEqual([ten.machineIds[4]]);
    expect(scoped.ranking.mode).toBe("single");
    expect(scoped.storeShareDeducted).toBe(true);
    expect(all.ranking.rows).toHaveLength(10);
  });

  it("arkiverade automater räknas inte: en kvar jämförs med sig själv, inte med de dolda", async () => {
    const three = await seedFleet(3);
    const owner = await viewerFor(three.owner, three.orgId);
    expect((await loadFleetRankingWith(loaders(owner), SP)).ranking.mode).toBe("fleet");
    // Automat 2 och 3 arkiveras: deras order ligger kvar i perioden.
    await asUser(three.owner, (tx) =>
      tx
        .update(s.machines)
        .set({ archivedAt: NOW })
        .where(inArray(s.machines.id, three.machineIds.slice(1))),
    );
    const data = await loadFleetRankingWith(loaders(owner), SP);
    expect([...data.machines.keys()]).toEqual([three.machineIds[0]]);
    expect(data.ranking.mode).toBe("single");
    expect(data.ranking.rows.map((x) => x.machineId)).toEqual([three.machineIds[0]]);
    expect(data.ranking.medianProfitPerDayOre).toBeNull();
    expect(data.ranking.rows[0]!.verdict).toBe("same");
    expect(data.ranking.rows[0]!.vsMedianOre).toBeNull();
  }, 120_000);

  it("påfyllaren får ingenting, läsaren får läsa", async () => {
    const refiller = await viewerFor(await createMember(ten.orgId, "refiller"), ten.orgId);
    const reader = await viewerFor(await createMember(ten.orgId, "viewer"), ten.orgId);
    await expect(loadFleetRankingWith(loaders(refiller), SP)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      loadBestAssortmentWith(loaders(refiller), ten.machineIds[0]!, SP),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect((await loadFleetRankingWith(loaders(reader), SP)).ranking.rows).toHaveLength(10);
  });

  it("en annan organisation syns aldrig", async () => {
    const data = await loadFleetRankingWith(loaders(oneOwner), SP);
    expect([...data.machines.keys()]).toEqual(one.machineIds);
    // Den andra organisationens automat ger ett tomt sortiment, inte dess order.
    const other = await loadBestAssortmentWith(loaders(oneOwner), ten.machineIds[5]!, SP);
    expect(other.assortment.rows).toEqual([]);
  });
});

describe("Bästa sortiment", () => {
  it("visar vad som säljer i automaten och föreslår byte mot det som säljer i andra", async () => {
    const { assortment: a, storeShareDeducted } = await loadBestAssortmentWith(
      loaders(tenOwner),
      ten.machineIds[0]!,
      SP,
    );
    expect(storeShareDeducted).toBe(false);
    expect(a.days).toBe(29);
    expect(a.rows.map((r) => r.titleId).sort()).toEqual(
      [ten.titles.a, ten.titles.flair, ten.titles.c, ten.titles.d].sort(),
    );
    const top = a.rows[0]!;
    expect(top.unitsPerDayMilli).toBe(1_000);
    // 100 kr − 40 kr inköp (ingen moms i testorganisationen), före butikens andel.
    expect(top.profitPerDayOre).toBe(6_000);
    expect(a.slow.map((r) => r.titleId)).toEqual([ten.titles.flair]);
    expect(a.otherMachines).toBe(9);
    expect(a.suggestions).toHaveLength(1);
    expect(a.suggestions[0]!.tryInstead).toMatchObject({
      titleId: ten.titles.e,
      unitsPerDayMilli: 2_000,
      machines: 9,
    });
    expect(a.suggestions[0]!.text).toBe(
      "Byt ut White Flair: säljer under 0,1/dag. Prova 30th Celebration: säljer 2/dag i 9 andra automater.",
    );
  });

  it("med vyknappen är vinsten per dag efter butikens andel", async () => {
    const before = await loadBestAssortmentWith(loaders(tenOwner), ten.machineIds[0]!, SP);
    const after = await loadBestAssortmentWith(loaders(tenOwner, true), ten.machineIds[0]!, SP);
    expect(after.storeShareDeducted).toBe(true);
    expect(after.assortment.rows[0]!.profitPerDayOre!).toBeLessThan(
      before.assortment.rows[0]!.profitPerDayOre!,
    );
  });

  it("en enda automat: det som står still visas, men inget att prova", async () => {
    const { assortment: a } = await loadBestAssortmentWith(
      loaders(oneOwner),
      one.machineIds[0]!,
      SP,
    );
    expect(a.slow.map((r) => r.titleId)).toEqual([one.titles.flair]);
    expect(a.otherMachines).toBe(0);
    expect(a.suggestions.map((x) => x.tryInstead)).toEqual([null]);
  });

  it("för kort period: sägs, inga förslag", async () => {
    const { assortment: a } = await loadBestAssortmentWith(loaders(tenOwner), ten.machineIds[0]!, {
      period: "7d",
    });
    expect(a.tooShort).toBe(true);
    expect(a.suggestions).toEqual([]);
    expect(a.rows.length).toBeGreaterThan(0);
  });
});

describe("Inga N+1-frågor", () => {
  let counter: RoundTripCounter;
  beforeAll(async () => {
    counter = await installRoundTripCounter();
  });
  afterAll(async () => {
    await counter.restore();
  });

  async function trips(fn: () => Promise<unknown>): Promise<number> {
    counter.reset();
    await fn();
    return counter.count();
  }

  it("rangordningen: lika många rundresor med 1 som med 10 automater", async () => {
    const small = await trips(() => loadFleetRankingWith(loaders(oneOwner), SP));
    const big = await trips(() => loadFleetRankingWith(loaders(tenOwner), SP));
    expect(big).toBe(small);
  });

  it("bästa sortiment: lika många rundresor med 1 som med 10 automater", async () => {
    const small = await trips(() =>
      loadBestAssortmentWith(loaders(oneOwner), one.machineIds[0]!, SP),
    );
    const big = await trips(() =>
      loadBestAssortmentWith(loaders(tenOwner), ten.machineIds[0]!, SP),
    );
    expect(big).toBe(small);
  });
});
