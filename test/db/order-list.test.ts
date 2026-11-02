/**
 * Orderlistans laddare (src/app/(app)/order/_lib/service) mot testdatabasen: filter,
 * sökning, sortering, sidor, detaljvyn, export och behörighet. Påfyllaren får aldrig en
 * order, varken via laddarna (rollkontroll) eller via frågorna (RLS).
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "@/db/schema";
import {
  DEFAULT_SORT,
  parseOrderParams,
  type OrderParams,
  type OrderSort,
} from "@/app/(app)/order/_lib/params";
import { queryOrderRows } from "@/app/(app)/order/_lib/queries";
import {
  loadOrderDetailFor,
  loadOrderExportFor,
  loadOrderListFor,
  loadOrderPageFor,
  type OrderListArgs,
} from "@/app/(app)/order/_lib/service";
import {
  AuthorizationError,
  listOrganizationsFor,
  withUserDbFor,
  type SessionUser,
} from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const MARCH = { start: "2025-03-01", end: "2025-03-31" };
const FEBRUARY = { start: "2025-02-01", end: "2025-02-28" };
const NOW = new Date("2025-04-02T09:00:00Z");
const NO_SCOPE = { storeId: null, machineId: null };

function sessionUser(u: TestUser): SessionUser {
  return { userId: u.id, email: u.email };
}

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = sessionUser(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

function args(
  over: Partial<Omit<OrderListArgs, "params">> & { params?: Partial<OrderParams> } = {},
): OrderListArgs {
  return {
    period: over.period ?? MARCH,
    compare: over.compare === undefined ? FEBRUARY : over.compare,
    scope: over.scope ?? NO_SCOPE,
    params: { ...parseOrderParams({}), ...over.params },
  };
}

/** Minsta möjliga organisation för orderlistan (utan avtal och kontrakt). */
interface OrderFixture {
  orgId: string;
  owner: TestUser;
  storeId: string;
  machineId: string;
  titleId: string;
  secondTitleId: string;
  dataSourceId: string;
  importId: string;
  orderIds: string[];
}

async function seedOrderFixture(): Promise<OrderFixture> {
  const owner = await createUser(`order-owner-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Orderfixtur ${uniqueSuffix()}`);
  return asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "ICA Testbutik" })
      .returning();
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2025-01-01" });
    const [title, secondTitle, duplicate] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Pokémon 151 Booster", series: "Scarlet & Violet" },
        { ...org, name: "Surging Sparks Booster", series: "Scarlet & Violet" },
        { ...org, name: "Pokemon 151 booster pack", series: "Scarlet & Violet" },
      ])
      .returning();
    await tx.execute(sql`select public.merge_titles(${orgId}, ${duplicate!.id}, ${title!.id})`);
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const [sourceMachine] = await tx
      .insert(s.sourceMachines)
      .values({
        ...org,
        dataSourceId: source!.id,
        externalId: "AW-1",
        externalName: "Order Machine 1",
        machineId: machine!.id,
      })
      .returning();
    const [imp] = await tx
      .insert(s.imports)
      .values({
        ...org,
        dataSourceId: source!.id,
        trigger: "upload",
        fileName: "orders.csv",
        storagePath: `${orgId}/imports/orders.csv`,
        parserVersion: "awish-csv@1",
        rowsTotal: 2,
        rowsNew: 2,
        status: "succeeded",
      })
      .returning();
    const base = {
      ...org,
      dataSourceId: source!.id,
      sourceMachineId: sourceMachine!.id,
      machineId: machine!.id,
      importId: imp!.id,
    };
    const orders = await tx
      .insert(s.orders)
      .values([
        {
          ...base,
          externalId: "42001",
          rawTitle: "Pokemon 151",
          titleId: title!.id,
          orderedAt: new Date("2025-03-10T10:00:00Z"),
          amountOre: 7900,
          paymentMethod: "card",
          sourceHash: "h1",
        },
        {
          ...base,
          externalId: "42002",
          rawTitle: "Surging Sparks",
          titleId: secondTitle!.id,
          orderedAt: new Date("2025-03-11T10:00:00Z"),
          amountOre: 8900,
          paymentMethod: "swish",
          sourceHash: "h2",
        },
      ])
      .returning();
    await tx.insert(s.importRows).values({
      ...org,
      importId: imp!.id,
      rowNumber: 1,
      raw: { "Order No.": "42001" },
      status: "new",
      orderId: orders[0]!.id,
    });
    return {
      orgId,
      owner,
      storeId: store!.id,
      machineId: machine!.id,
      titleId: title!.id,
      secondTitleId: secondTitle!.id,
      dataSourceId: source!.id,
      importId: imp!.id,
      orderIds: orders.map((o) => o.id),
    };
  });
}

let fx: OrderFixture;
let owner: Viewer;
let reader: Viewer;
let refiller: Viewer;
let otherOwner: Viewer;
let otherOrderId: string;
let store2: string;
let machine2: string;
/** Order som läggs till utöver fixturens två (42001, 42002). */
const EXTRA = 30;

beforeAll(async () => {
  fx = await seedOrderFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
  reader = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
  refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);

  await asUser(fx.owner, async (tx) => {
    const org = { organizationId: fx.orgId };
    const [st] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Åhléns City" })
      .returning();
    store2 = st!.id;
    const [m] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-002", name: "Automat Centrum", activeFrom: "2025-01-01" })
      .returning();
    machine2 = m!.id;
    // BL-002 står i Åhléns till 14 mars och i ICA Testbutik från 15 mars.
    await tx.insert(s.machinePlacements).values([
      {
        ...org,
        machineId: machine2,
        storeId: store2,
        validFrom: "2025-01-01",
        validTo: "2025-03-14",
      },
      { ...org, machineId: machine2, storeId: fx.storeId, validFrom: "2025-03-15" },
    ]);
    const rows = Array.from({ length: EXTRA }, (_, i) => ({
      ...org,
      dataSourceId: fx.dataSourceId,
      externalId: String(43000 + i),
      rawTitle: i % 3 === 0 ? "Pokemon 151" : "Surging Sparks",
      titleId: i % 3 === 0 ? fx.titleId : fx.secondTitleId,
      // 1–30 mars, en order om dagen kl. 12 svensk tid (11 UTC).
      orderedAt: new Date(Date.UTC(2025, 2, 1 + i, 11, 0, 0)),
      amountOre: 5000 + (i % 5) * 1000,
      machineId: i % 2 === 0 ? fx.machineId : machine2,
      importId: fx.importId,
      sourceHash: `x${i}`,
    }));
    rows.push({
      ...org,
      dataSourceId: fx.dataSourceId,
      externalId: "43999",
      rawTitle: "Okänd 50%_rabatt",
      titleId: null as unknown as string,
      orderedAt: new Date("2025-03-20T15:00:00Z"),
      amountOre: 100,
      machineId: fx.machineId,
      importId: fx.importId,
      sourceHash: "okand",
    });
    rows.push({
      ...org,
      dataSourceId: fx.dataSourceId,
      externalId: "41000",
      rawTitle: "Pokemon 151",
      titleId: fx.titleId,
      orderedAt: new Date("2025-02-10T10:00:00Z"),
      amountOre: 7000,
      machineId: fx.machineId,
      importId: fx.importId,
      sourceHash: "feb",
    });
    await tx.insert(s.orders).values(rows);
  });

  const other = await seedOrderFixture();
  otherOwner = await viewerFor(other.owner, other.orgId);
  otherOrderId = other.orderIds[0]!;
});

describe("loadOrderListFor", () => {
  it("räknar och summerar perioden, jämför med samma filter och ger första sidan", async () => {
    const list = await loadOrderListFor(owner, args(), NOW);
    // 42001, 42002, 30 extra, 43999 i mars.
    expect(list.totals.count).toBe(EXTRA + 3);
    const extraSum = Array.from({ length: EXTRA }, (_, i) => 5000 + (i % 5) * 1000).reduce(
      (a, b) => a + b,
      0,
    );
    expect(list.totals.amountOre).toBe(7900 + 8900 + 100 + extraSum);
    expect(list.compareTotals).toEqual({ count: 1, amountOre: 7000 });
    expect(list.latestOrderAt).toBe("2025-03-30T11:00:00.000Z");
    expect(list.nextOffset).toBeNull();
    // Nyaste först.
    expect(list.rows[0]?.externalId).toBe("43029");
    expect(list.refs.machines.map((m) => m.code)).toEqual(["BL-001", "BL-002"]);
  });

  it("sätter butiken efter placeringen orderns dag", async () => {
    const list = await loadOrderListFor(owner, args({ params: { q: "BL-002" } }), NOW);
    const early = list.rows.find((r) => r.externalId === "43001"); // 2 mars
    const late = list.rows.find((r) => r.externalId === "43029"); // 30 mars
    expect(early?.storeId).toBe(store2);
    expect(late?.storeId).toBe(fx.storeId);
  });

  it("filtrerar på butik med placeringen orderns dag, och på automat och titel", async () => {
    const inAhlens = await loadOrderListFor(
      owner,
      args({ scope: { storeId: store2, machineId: null } }),
      NOW,
    );
    // BL-002 har ojämna i (1, 3, …, 13) före 15 mars: 7 order.
    expect(inAhlens.totals.count).toBe(7);
    expect(inAhlens.rows.every((r) => r.storeId === store2)).toBe(true);

    const bl2 = await loadOrderListFor(
      owner,
      args({ scope: { storeId: null, machineId: machine2 } }),
      NOW,
    );
    expect(bl2.totals.count).toBe(EXTRA / 2);

    const pokemon = await loadOrderListFor(owner, args({ params: { titleId: fx.titleId } }), NOW);
    expect(pokemon.rows.every((r) => r.titleId === fx.titleId)).toBe(true);
    expect(pokemon.totals.count).toBe(1 + EXTRA / 3);
  });

  it("söker i ordernummer, originaltitel, titel, automat och butik; alla ord måste träffa", async () => {
    const count = async (q: string) =>
      (await loadOrderListFor(owner, args({ params: { q } }), NOW)).totals.count;
    expect(await count("42001")).toBe(1);
    expect(await count("pokemon")).toBe(1 + EXTRA / 3); // originaltitel och titel (Pokémon)
    expect(await count("booster")).toBe(2 + EXTRA); // tolkad titel; ordern utan titel träffas inte
    expect(await count("åhléns")).toBe(7);
    expect(await count("surging bl-002")).toBe(
      Array.from({ length: EXTRA }, (_, i) => i).filter((i) => i % 3 !== 0 && i % 2 === 1).length,
    );
    // %, _ och \ är vanliga tecken.
    expect(await count("50%_")).toBe(1);
    expect(await count("%")).toBe(1);
    expect(await count("_")).toBe(1);
    expect(await count("finnsinte")).toBe(0);
  });

  it("ger läsaren samma lista som ägaren", async () => {
    const a = await loadOrderListFor(owner, args(), NOW);
    const b = await loadOrderListFor(reader, args(), NOW);
    expect(b.totals).toEqual(a.totals);
    expect(b.rows.map((r) => r.id)).toEqual(a.rows.map((r) => r.id));
  });
});

describe("sortering och sidor", () => {
  async function allIds(sort: OrderSort, pageSize: number): Promise<string[]> {
    const first = await loadOrderListFor(owner, args({ params: { sort } }), NOW, pageSize);
    const ids = first.rows.map((r) => r.id);
    let next = first.nextOffset;
    while (next !== null) {
      const page = await loadOrderPageFor(owner, args({ params: { sort } }), next, NOW, pageSize);
      ids.push(...page.rows.map((r) => r.id));
      next = page.nextOffset;
    }
    return ids;
  }

  it("ger samma ordning sida för sida som i en enda hämtning, utan dubbletter", async () => {
    for (const sort of [
      DEFAULT_SORT,
      { key: "belopp", dir: "desc" },
      { key: "belopp", dir: "asc" },
      { key: "titel", dir: "asc" },
      { key: "automat", dir: "desc" },
      { key: "butik", dir: "asc" },
      { key: "nr", dir: "asc" },
    ] as OrderSort[]) {
      const whole = await allIds(sort, 1000);
      const paged = await allIds(sort, 7);
      expect(paged).toEqual(whole);
      expect(new Set(paged).size).toBe(EXTRA + 3);
    }
  });

  it("sorterar belopp, titel (svensk ordning, saknad titel sist) och ordernummer numeriskt", async () => {
    const byAmount = await loadOrderListFor(
      owner,
      args({ params: { sort: { key: "belopp", dir: "desc" } } }),
      NOW,
    );
    const amounts = byAmount.rows.map((r) => r.amountOre);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));

    const byTitle = await loadOrderListFor(
      owner,
      args({ params: { sort: { key: "titel", dir: "desc" } } }),
      NOW,
    );
    expect(byTitle.rows.at(-1)?.titleId).toBeNull();
    expect(byTitle.rows[0]?.titleId).toBe(fx.secondTitleId); // Surging före Pokémon i fallande

    const byNr = await loadOrderListFor(
      owner,
      args({ params: { sort: { key: "nr", dir: "asc" } } }),
      NOW,
    );
    expect(byNr.rows[0]?.externalId).toBe("42001");
    expect(byNr.rows.at(-1)?.externalId).toBe("43999");
  });
});

describe("loadOrderDetailFor", () => {
  it("ger originaltitel, tolkad titel, automat, butik, källa och importens rad", async () => {
    const d = await loadOrderDetailFor(owner, fx.orderIds[0]!);
    expect(d).toMatchObject({
      externalId: "42001",
      rawTitle: "Pokemon 151",
      title: { id: fx.titleId, name: "Pokémon 151 Booster" },
      machine: { id: fx.machineId, code: "BL-001" },
      store: { id: fx.storeId, name: "ICA Testbutik" },
      sourceMachine: { externalId: "AW-1", externalName: "Order Machine 1" },
      dataSource: { id: fx.dataSourceId, provider: "awish_csv" },
      import: { id: fx.importId, fileName: "orders.csv", trigger: "upload", rowNumber: 1 },
      amountOre: 7900,
      businessDate: "2025-03-10",
    });
  });

  it("ger null för en annan organisations order och för skräp", async () => {
    expect(await loadOrderDetailFor(owner, otherOrderId)).toBeNull();
    expect(await loadOrderDetailFor(owner, "inte-ett-id")).toBeNull();
  });
});

describe("loadOrderExportFor", () => {
  it("tar alla rader i vald sortering med originaltiteln", async () => {
    const res = await loadOrderExportFor(
      owner,
      args({ params: { sort: { key: "nr", dir: "asc" } } }),
      NOW,
    );
    expect(res.truncated).toBe(false);
    expect(res.rows).toHaveLength(EXTRA + 3);
    expect(res.rows[0]).toMatchObject({ externalId: "42001", rawTitle: "Pokemon 151" });
  });
});

describe("behörighet", () => {
  it("nekar påfyllaren i varje laddare", async () => {
    await expect(loadOrderListFor(refiller, args(), NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(loadOrderPageFor(refiller, args(), 0, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(loadOrderExportFor(refiller, args(), NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(loadOrderDetailFor(refiller, fx.orderIds[0]!)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("ger påfyllaren inga order även om rollkontrollen kringgås (RLS)", async () => {
    const res = await withUserDbFor(refiller.user, (tx) =>
      queryOrderRows(
        tx,
        fx.orgId,
        {
          period: MARCH,
          placements: [],
          storeId: null,
          machineId: null,
          titleId: null,
          terms: [],
        },
        DEFAULT_SORT,
        { titles: [], machines: [], stores: [] },
        0,
        100,
      ),
    );
    expect(res.rows).toEqual([]);
  });

  it("nekar en ägare i en annan organisation", async () => {
    const intruder: Viewer = { user: otherOwner.user, organization: owner.organization };
    await expect(loadOrderListFor(intruder, args(), NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(loadOrderDetailFor(intruder, fx.orderIds[0]!)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
