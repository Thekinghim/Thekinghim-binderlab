/**
 * Pengar i V2 (G4) mot testdatabasen, med sidladdarna för en given användare
 * (viewerPageLoaders: rollen ur databasen, allt under RLS).
 *
 * - Vinst per automat och månad: vinsten delad med dagarna i tjänst, samma tal som
 *   enhetsekonomin och samma vinst som Lönsamhet för månaden.
 * - Vattenfallet går ihop: intäkt − inköp − avgifter = vinst, och sista raden = vinst −
 *   butikernas andel − fasta kostnader.
 * - Påfyllaren får ingenting (laddarna kastar), läsaren får läsa.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadLonsamhetWith } from "@/app/(app)/lonsamhet/_lib/data";
import * as s from "@/db/schema";
import { addDays, profitability, type IsoDate } from "@/domain";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { viewerPageLoaders } from "@/server/data/page-loaders";
import { loadMoneyMonthsWith } from "@/server/data/v2/analytics/months12";
import { waterfallRows } from "@/server/data/v2/analytics/money-model";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));

const NOW = new Date("2025-06-20T09:00:00Z");
const LAST: IsoDate = "2025-06-19";

let orgId: string;
let owner: TestUser;
let refiller: TestUser;
let viewerUser: TestUser;
let machineIds: string[];

async function viewerFor(u: TestUser): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const loaders = async (u: TestUser) =>
  viewerPageLoaders(await viewerFor(u), { now: NOW, storeShare: false });

beforeAll(async () => {
  owner = await createUser(`pengar-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Pengar ${uniqueSuffix()}`);
  refiller = await createMember(orgId, "refiller");
  viewerUser = await createMember(orgId, "viewer");
  const org = { organizationId: orgId };
  machineIds = await asUser(owner, async (tx) => {
    const [title] = await tx
      .insert(s.titles)
      .values({ ...org, name: "Pokémon 151" })
      .returning();
    await tx
      .insert(s.purchasePrices)
      .values({ ...org, titleId: title!.id, unitCostOre: 4_000, validFrom: "2025-01-01" });
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const ids: string[] = [];
    let seq = 0;
    for (let i = 0; i < 2; i++) {
      const [store] = await tx
        .insert(s.stores)
        .values({ ...org, name: `Butik ${i + 1}`, city: i === 0 ? "Borås" : "Lerum" })
        .returning();
      await tx
        .insert(s.storeAgreements)
        .values({ ...org, storeId: store!.id, validFrom: "2025-01-01", commissionBp: 2000 });
      // Automat 2 kommer ut först 1 juni (nya och gamla ska gå att jämföra per dag).
      const from: IsoDate = i === 0 ? "2025-05-01" : "2025-06-01";
      const [machine] = await tx
        .insert(s.machines)
        .values({ ...org, code: `BL-${i + 1}`, name: `Automat ${i + 1}`, activeFrom: from })
        .returning();
      ids.push(machine!.id);
      await tx
        .insert(s.machinePlacements)
        .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: from });
      const orders = [];
      for (let day = from; day <= LAST; day = addDays(day, 1)) {
        for (let k = 0; k < i + 1; k++) {
          seq++;
          orders.push({
            ...org,
            dataSourceId: source!.id,
            machineId: machine!.id,
            paymentMethod: "card",
            externalId: `p-${i}-${seq}`,
            rawTitle: "x",
            titleId: title!.id,
            orderedAt: new Date(`${day}T10:00:00Z`),
            amountOre: 10_000,
            sourceHash: `ph-${i}-${seq}`,
          });
        }
      }
      for (let at = 0; at < orders.length; at += 500) {
        await tx.insert(s.orders).values(orders.slice(at, at + 500));
      }
    }
    return ids;
  });
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
});

describe("vinst per automat och månad", () => {
  it("vinst per dag i tjänst, och månadens vinst är Lönsamhets", async () => {
    const l = await loaders(owner);
    const table = await loadMoneyMonthsWith(l);
    expect(table.months.map((m) => m.month)).toEqual(["2025-05", "2025-06"]);
    expect(table.months[1]!.running).toBe(true);
    const one = table.rows.find((r) => r.machineId === machineIds[0])!;
    const two = table.rows.find((r) => r.machineId === machineIds[1])!;
    // Automat 2 stod inte ute i maj.
    expect(two.values[0]).toBeNull();
    expect(two.values[1]).not.toBeNull();
    // Säljer dubbelt så mycket per dag: dubbel vinst per dag i tjänst.
    expect(two.values[1]!).toBe(one.values[1]! * 2);

    const june = await l.domainInput({ period: { start: "2025-06-01", end: "2025-06-20" } });
    const rows = profitability(june.current, "machine").rows;
    const juneOne = rows.find((r) => r.key === machineIds[0])!;
    expect(one.values[1]).toBe(Math.round(juneOne.profitOre / 20));
  });

  it("läsaren får läsa, påfyllaren får ingenting", async () => {
    await expect(loadMoneyMonthsWith(await loaders(viewerUser))).resolves.toBeDefined();
    await expect(loadMoneyMonthsWith(await loaders(refiller))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe("från intäkt till vinst", () => {
  it("går ihop med Lönsamhets brygga", async () => {
    const { model } = await loadLonsamhetWith(await loaders(owner), { period: "30d" });
    const b = model.bridge;
    const rows = waterfallRows({
      revenueOre: b.revenueOre,
      vmbVatOre: b.vmbVatOre,
      costOre: b.costOre,
      feesOre: b.feesOre,
      profitBeforeShareOre: b.profitBeforeShareOre,
      compensationOre: b.compensationOre,
      refundOre: 0,
      freePackOre: 0,
      fixedCostOre: null,
      cardFeeBp: null,
      stores: 2,
    });
    const by = new Map(rows.map((r) => [r.key, r.valueOre]));
    expect(b.revenueOre + by.get("cost")! + by.get("fees")! + (by.get("vmb") ?? 0)).toBe(
      by.get("profit"),
    );
    expect(by.get("profit")).toBe(b.profitOre);
    expect(by.get("result")).toBe(b.profitBeforeShareOre - b.compensationOre);
    expect(b.compensationOre).toBeGreaterThan(0);
  });
});
