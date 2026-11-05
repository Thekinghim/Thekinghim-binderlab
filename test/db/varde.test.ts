/**
 * Värde (/varde och månadsrapporten) mot testdatabasen: bara ägare och admin, bara den egna
 * organisationens data, RPC:n varde_automation_counts och loggen automation_log.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "@/db/schema";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { loadValueFor, loadValueTeaserFor } from "@/server/varde/load";
import { logAwishPushes } from "@/server/varde/log";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const NOW = new Date("2025-04-05T09:00:00Z");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

interface Fixture {
  orgId: string;
  owner: TestUser;
  machineId: string;
  titleId: string;
}

/**
 * En automat med en titel (inköp 30 kr). Inventering 5 pack 1 mars, en order à 79 kr per
 * dag 2–9 mars, påfyllning +10 den 4 mars kl. 09 (3 pack kvar: i tid). Efter påfyllningen
 * säljs 6 pack, alltså 3 utöver de 3 som fanns: 3 räddade pack (7, 8 och 9 mars).
 */
async function seed(name: string): Promise<Fixture> {
  const owner = await createUser(`varde-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `${name} ${uniqueSuffix()}`);
  return asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: `${name} butik` })
      .returning();
    await tx
      .insert(s.storeAgreements)
      .values({ ...org, storeId: store!.id, validFrom: "2025-01-01", commissionBp: 1000 });
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: `${name} automat`, activeFrom: "2025-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2025-01-01" });
    const [title] = await tx
      .insert(s.titles)
      .values({ ...org, name: `${name} Booster` })
      .returning();
    await tx
      .insert(s.purchasePrices)
      .values({ ...org, titleId: title!.id, unitCostOre: 3000, validFrom: "2025-01-01" });
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const [loc] = await rows<{ id: string }>(
      tx,
      sql`select id from public.stock_locations
          where organization_id = ${orgId}::uuid and machine_id = ${machine!.id}::uuid`,
    );
    await tx.insert(s.stockEvents).values({
      ...org,
      locationId: loc!.id,
      titleId: title!.id,
      kind: "count",
      quantity: 5,
      occurredAt: new Date("2025-03-01T07:00:00Z"),
    });
    await tx.insert(s.stockEvents).values({
      ...org,
      locationId: loc!.id,
      titleId: title!.id,
      kind: "refill",
      quantity: 10,
      occurredAt: new Date("2025-03-04T08:00:00Z"),
    });
    await tx.insert(s.orders).values(
      [2, 3, 4, 5, 6, 7, 8, 9].map((d) => ({
        ...org,
        dataSourceId: source!.id,
        machineId: machine!.id,
        paymentMethod: "card",
        externalId: `o${d}`,
        rawTitle: `${name} Booster`,
        titleId: title!.id,
        orderedAt: new Date(`2025-03-0${d}T10:00:00Z`),
        amountOre: 7900,
        sourceHash: `h${d}`,
      })),
    );
    return { orgId, owner, machineId: machine!.id, titleId: title!.id };
  });
}

let a: Fixture;
let b: Fixture;
let owner: Viewer;
let admin: Viewer;
let reader: Viewer;
let refiller: Viewer;
let otherOwner: Viewer;
let readerUser: TestUser;

beforeAll(async () => {
  a = await seed("Alfa");
  b = await seed("Beta");
  owner = await viewerFor(a.owner, a.orgId);
  admin = await viewerFor(await createMember(a.orgId, "admin"), a.orgId);
  readerUser = await createMember(a.orgId, "viewer");
  reader = await viewerFor(readerUser, a.orgId);
  refiller = await viewerFor(await createMember(a.orgId, "refiller"), a.orgId);
  otherOwner = await viewerFor(b.owner, b.orgId);
});

describe("loadValueFor", () => {
  it("ger ägaren månadens värde ur organisationens egna data", async () => {
    const data = await loadValueFor(owner, "2025-03", NOW);
    expect(data.month).toBe("2025-03");
    expect(data.partial).toBe(false);
    expect(data.hasData).toBe(true);
    expect(data.refill?.refills).toEqual({ onTime: 1, afterEmpty: 0, unknown: 0 });
    expect(data.refill?.savedUnits).toBe(3);
    const netPerPack = data.margin!.current.revenueOre / 8;
    expect(data.refill?.savedRevenueOre).toBe(3 * netPerPack);
    expect(data.margin?.current.orders).toBe(8);
    // Kvar efter inköp = försäljning − 8 × 30 kr (inga kortavgifter i testorganisationen
    // om inställningen är 0; annars dras de också).
    expect(data.margin!.current.keptOre).toBeLessThanOrEqual(
      data.margin!.current.revenueOre - 24_000,
    );
    // En påfyllningsdag (automat och dag) räknas som en uppgift.
    expect(data.time.lines.find((l) => l.kind === "refill_visit")?.count).toBe(1);
    expect(data.names.machines.map((m) => m.id)).toEqual([a.machineId]);
    // Går att skicka till klienten.
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });

  it("admin får samma siffror", async () => {
    const mine = await loadValueFor(owner, "2025-03", NOW);
    const theirs = await loadValueFor(admin, "2025-03", NOW);
    expect(theirs.margin?.current).toEqual(mine.margin?.current);
  });

  it("nekar läsaren och påfyllaren", async () => {
    await expect(loadValueFor(reader, "2025-03", NOW)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(loadValueFor(refiller, "2025-03", NOW)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await loadValueTeaserFor(reader, NOW)).toBeNull();
  });

  it("visar aldrig en annan organisations data", async () => {
    const theirs = await loadValueFor(otherOwner, "2025-03", NOW);
    expect(theirs.names.machines.map((m) => m.id)).toEqual([b.machineId]);
    expect(theirs.names.titles.some((t) => t.id === a.titleId)).toBe(false);
    expect(theirs.margin?.machines.map((m) => m.key)).toEqual([b.machineId]);
  });

  it("okänd månad ger förra månaden", async () => {
    const data = await loadValueFor(owner, "1999-01", NOW);
    expect(data.month).toBe("2025-03");
  });
});

describe("varde_automation_counts", () => {
  const call = (orgId: string) =>
    sql`select to_char(month, 'YYYY-MM') as month, kind, n
        from public.varde_automation_counts(${orgId}::uuid, '2025-03-01'::date, '2025-03-31'::date)`;

  it("räknar påfyllningsdagar för ägaren", async () => {
    const list = await asUser(a.owner, (tx) =>
      rows<{ month: string; kind: string; n: number }>(tx, call(a.orgId)),
    );
    expect(list).toEqual([{ month: "2025-03", kind: "refill_visit", n: 1 }]);
  });

  it("nekar läsaren och en annan organisations ägare", async () => {
    const asReader = await asUser(readerUser, (tx) =>
      attempt(tx, (sp) => sp.execute(call(a.orgId))),
    );
    expect(asReader.code).toBe("42501");
    const asOther = await asUser(b.owner, (tx) => attempt(tx, (sp) => sp.execute(call(a.orgId))));
    expect(asOther.code).toBe("42501");
  });

  it("vägrar en orimlig period", async () => {
    const out = await asUser(a.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select * from public.varde_automation_counts(${a.orgId}::uuid, '2025-03-31'::date, '2025-03-01'::date)`,
        ),
      ),
    );
    expect(out.code).toBe("22023");
  });
});

describe("automation_log", () => {
  it("servern loggar Awish-push; ägaren ser den, läsaren och andra inte", async () => {
    const n = await logAwishPushes(db(), a.orgId, [
      { machineId: a.machineId, status: "pushed", slotsUpdated: 4 },
      { machineId: a.machineId, status: "nothing", slotsUpdated: 0 },
      { machineId: a.machineId, status: "error", slotsUpdated: 0 },
    ]);
    expect(n).toBe(1);
    const mine = await asUser(a.owner, (tx) =>
      rows<{ units: number }>(tx, sql`select units from public.automation_log`),
    );
    expect(mine).toEqual([{ units: 4 }]);
    const asReader = await asUser(readerUser, (tx) =>
      rows(tx, sql`select * from public.automation_log`),
    );
    expect(asReader).toEqual([]);
    const asOther = await asUser(b.owner, (tx) =>
      rows(tx, sql`select * from public.automation_log`),
    );
    expect(asOther).toEqual([]);
    const teaser = await loadValueTeaserFor(owner);
    expect(teaser?.minutes).toBeGreaterThanOrEqual(3);
  });

  it("klientroller kan inte skriva, ändra eller ta bort", async () => {
    const insert = await asUser(a.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.automation_log (organization_id, kind) values (${a.orgId}::uuid, 'awish_push')`,
        ),
      ),
    );
    expect(insert.code).toBe("42501");
    const del = await asUser(a.owner, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`delete from public.automation_log`)),
    );
    expect(del.code).toBe("42501");
  });
});
