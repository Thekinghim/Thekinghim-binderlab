/**
 * Periodvalet "överallt" mot testdatabasen: I går, eget intervall (?fran=&till= och
 * ?from=&to=) och "Sålt i går" (loadDaySalesWith) med sidladdarna för en given användare
 * (viewerPageLoaders: rollen ur databasen, allt under RLS).
 *
 * - I går = gårdagen i organisationens tidszon, jämförd med dagen innan; Lönsamhets modell
 *   (samma som Pengar och Hem) räknar just de dagarna.
 * - Sålt i går: per titel, automat och timme; summan = Lönsamhets vinst för dagen.
 * - Eget intervall: båda ändar ingår, ?fran/?till som ?from/?to, skräp ger 30 dagar.
 * - Påfyllaren får bara antal (ur lagret), aldrig kronor; läsaren får beloppen.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadLonsamhetWith } from "@/app/(app)/lonsamhet/_lib/data";
import * as s from "@/db/schema";
import { profitability, type IsoDate } from "@/domain";
import { listOrganizationsFor } from "@/server/access";
import { loadSalesCountsFor, type Viewer } from "@/server/data/core/loaders";
import { viewerPageLoaders } from "@/server/data/page-loaders";
import { loadDaySalesWith } from "@/server/data/v2/analytics/day-sales";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));

// 11:00 i Stockholm lördag 20 juni 2025: i går = fredag 19 juni.
const NOW = new Date("2025-06-20T09:00:00Z");
const YESTERDAY: IsoDate = "2025-06-19";

let orgId: string;
let owner: TestUser;
let refiller: TestUser;
let viewerUser: TestUser;
let titleA: string;
let titleB: string;
let m1: string;
let m2: string;

async function viewerFor(u: TestUser): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

async function daySales(u: TestUser, sp: Record<string, string>) {
  const viewer = await viewerFor(u);
  const loaders = viewerPageLoaders(viewer, { now: NOW, storeShare: false });
  return loadDaySalesWith(loaders, (args) => loadSalesCountsFor(viewer, args), sp);
}

beforeAll(async () => {
  owner = await createUser(`datum-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Datum ${uniqueSuffix()}`);
  refiller = await createMember(orgId, "refiller");
  viewerUser = await createMember(orgId, "viewer");
  const org = { organizationId: orgId };
  await asUser(owner, async (tx) => {
    const [a] = await tx
      .insert(s.titles)
      .values({ ...org, name: "Pokémon 151" })
      .returning();
    const [b] = await tx
      .insert(s.titles)
      .values({ ...org, name: "Prismatic" })
      .returning();
    titleA = a!.id;
    titleB = b!.id;
    await tx
      .insert(s.purchasePrices)
      .values({ ...org, titleId: titleA, unitCostOre: 4_000, validFrom: "2025-01-01" });
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Butiken", city: "Borås" })
      .returning();
    await tx
      .insert(s.storeAgreements)
      .values({ ...org, storeId: store!.id, validFrom: "2025-01-01", commissionBp: 1000 });
    const ids: string[] = [];
    for (const code of ["BL-1", "BL-2"]) {
      const [m] = await tx
        .insert(s.machines)
        .values({ ...org, code, name: `Automat ${code}`, activeFrom: "2025-05-01" })
        .returning();
      await tx
        .insert(s.machinePlacements)
        .values({ ...org, machineId: m!.id, storeId: store!.id, validFrom: "2025-05-01" });
      ids.push(m!.id);
    }
    m1 = ids[0]!;
    m2 = ids[1]!;
    let n = 0;
    const order = (titleId: string, machineId: string, at: string) => ({
      ...org,
      dataSourceId: source!.id,
      machineId,
      paymentMethod: "card",
      externalId: `d-${++n}`,
      rawTitle: "x",
      titleId,
      orderedAt: new Date(at),
      amountOre: 10_000,
      sourceHash: `dh-${n}`,
    });
    await tx.insert(s.orders).values([
      // I går: två kl. 10 (08 UTC), en kl. 16 (14:30 UTC), en strax före midnatt (21:50 UTC).
      order(titleA, m1, "2025-06-19T08:05:00Z"),
      order(titleA, m1, "2025-06-19T08:40:00Z"),
      order(titleB, m2, "2025-06-19T14:30:00Z"),
      order(titleA, m2, "2025-06-19T21:50:00Z"),
      // Dagen innan (jämförelsen) och i dag.
      order(titleA, m1, "2025-06-18T09:00:00Z"),
      order(titleB, m1, "2025-06-20T07:00:00Z"),
      // Ett eget intervall 10–12 juni.
      order(titleA, m1, "2025-06-10T09:00:00Z"),
      order(titleB, m2, "2025-06-12T19:00:00Z"),
      order(titleA, m2, "2025-06-13T09:00:00Z"),
    ]);
  });
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
});

describe("I går", () => {
  it("perioden är gårdagen och jämförs med dagen innan (Lönsamhets modell)", async () => {
    const loaders = viewerPageLoaders(await viewerFor(owner), { now: NOW, storeShare: false });
    const p = await loaders.period({ period: "igar" });
    expect(p.key).toBe("igar");
    expect(p.period).toEqual({ start: YESTERDAY, end: YESTERDAY });
    expect(p.compare).toEqual({ start: "2025-06-18", end: "2025-06-18" });
    const { model } = await loadLonsamhetWith(loaders, { period: "igar" });
    expect(model.orders).toBe(4);
    expect(model.compare).toEqual({ start: "2025-06-18", end: "2025-06-18" });
  });

  it("Sålt i går: per titel, automat och timme, och vinsten är Lönsamhets", async () => {
    const v = await daySales(owner, { period: "igar" });
    expect(v.singleDay).toBe(true);
    expect(v.name).toBe("I går");
    expect(v.sales.economy).toBe(true);
    expect(v.sales.units).toBe(4);
    expect(v.sales.titles.map((t) => [t.id, t.units])).toEqual([
      [titleA, 3],
      [titleB, 1],
    ]);
    expect(v.sales.machines.map((m) => [m.id, m.units])).toEqual([
      [m1, 2],
      [m2, 2],
    ]);
    // Timmar i Stockholm (sommartid, UTC+2).
    expect(v.sales.hours[10]?.units).toBe(2);
    expect(v.sales.hours[16]?.units).toBe(1);
    expect(v.sales.hours[23]?.units).toBe(1);
    // Titeln utan inköpspris har ingen vinst; totalen = Lönsamhets vinst för dagen.
    expect(v.sales.titles.find((t) => t.id === titleB)?.profitOre).toBeNull();
    const loaders = viewerPageLoaders(await viewerFor(owner), { now: NOW, storeShare: false });
    const input = await loaders.domainInput({ period: { start: YESTERDAY, end: YESTERDAY } });
    expect(v.sales.profitOre).toBe(profitability(input.current, "title").totals.profitOre);
    expect(v.sales.profitOre).toBeGreaterThan(0);
  });

  it("läsaren får beloppen", async () => {
    const v = await daySales(viewerUser, { period: "igar" });
    expect(v.sales.economy).toBe(true);
    expect(v.sales.revenueOre).toBeGreaterThan(0);
  });

  it("påfyllaren får bara antal ur lagret, aldrig kronor", async () => {
    const v = await daySales(refiller, { period: "igar" });
    expect(v.sales.economy).toBe(false);
    expect(v.sales.units).toBe(4);
    expect(v.sales.revenueOre).toBeNull();
    expect(v.sales.profitOre).toBeNull();
    expect(v.sales.hours).toEqual([]);
    expect(JSON.stringify(v)).not.toMatch(/"(revenueOre|profitOre)":-?\d/);
    expect(v.sales.titles.map((t) => [t.name, t.units])).toEqual([
      ["Pokémon 151", 3],
      ["Prismatic", 1],
    ]);
  });
});

describe("eget intervall", () => {
  it("?fran=&till= och ?from=&to= ger samma period, båda ändar ingår", async () => {
    const a = await daySales(owner, { fran: "2025-06-10", till: "2025-06-12" });
    const b = await daySales(owner, { from: "2025-06-10", to: "2025-06-12" });
    expect(a.period).toEqual({ start: "2025-06-10", end: "2025-06-12" });
    expect(b.period).toEqual(a.period);
    expect(a.sales.units).toBe(2);
    expect(a.singleDay).toBe(false);
    expect(a.sales.hours).toEqual([]);
    const loaders = viewerPageLoaders(await viewerFor(owner), { now: NOW, storeShare: false });
    const p = await loaders.period({ fran: "2025-06-10", till: "2025-06-12" });
    expect(p.key).toBe("eget");
    expect(p.compare).toEqual({ start: "2025-06-07", end: "2025-06-09" });
    const { model } = await loadLonsamhetWith(loaders, { from: "2025-06-10", to: "2025-06-12" });
    expect(model.orders).toBe(2);
  });

  it("påfyllaren: samma antal i ett eget intervall", async () => {
    const v = await daySales(refiller, { from: "2025-06-10", to: "2025-06-12" });
    expect(v.sales.units).toBe(2);
    expect(v.sales.revenueOre).toBeNull();
  });

  it("skräp, framtid och för långt ger standardvalet (30 dagar), utan fel", async () => {
    const loaders = viewerPageLoaders(await viewerFor(owner), { now: NOW, storeShare: false });
    for (const sp of [
      { fran: "2025-13-40" },
      { from: "2025-07-01", to: "2025-07-02" },
      { from: "2020-01-01", to: "2025-06-20" },
      { period: "forra_manaden" },
    ]) {
      const p = await loaders.period(sp);
      expect(p.key, JSON.stringify(sp)).toBe("30d");
      expect(p.period).toEqual({ start: "2025-05-22", end: "2025-06-20" });
    }
  });

  it("Förra månaden: hela maj, jämförd med april", async () => {
    const loaders = viewerPageLoaders(await viewerFor(owner), { now: NOW, storeShare: false });
    const p = await loaders.period({ period: "forra-manaden" });
    expect(p.period).toEqual({ start: "2025-05-01", end: "2025-05-31" });
    expect(p.compare).toEqual({ start: "2025-04-01", end: "2025-04-30" });
  });
});
