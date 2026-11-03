/**
 * Att göra (src/app/(app)/att-gora/_lib/service.ts) mot testdatabasen: avbockning
 * (todo_dismissals med RLS), registrera påfyllning (register_refill) och slå ihop
 * titlar (merge_titles), per roll.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  dismissTodoFor,
  loadDismissedFor,
  mergeTitlesFor,
  registerRefillFor,
  undoDismissFor,
} from "@/app/(app)/att-gora/_lib/service";
import * as s from "@/db/schema";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import { loadTodosFor, type Viewer } from "@/server/data/core/loaders";
import { loadRankedTodoStateFor } from "@/server/data/todos";

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

/** 74 timmar efter fixturens sista order (11 mars 10:00): automaten är tyst. */
const NOW = new Date("2025-03-14T12:00:00Z");

function sessionUser(u: TestUser): SessionUser {
  return { userId: u.id, email: u.email };
}

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = sessionUser(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

interface Fixture {
  orgId: string;
  owner: TestUser;
  machineId: string;
  machineLocationId: string;
  centralLocationId: string;
  titleId: string;
  secondTitleId: string;
}

/**
 * En egen, liten organisation: en automat i en butik, två titlar med inköpspris,
 * två order (10 och 11 mars 2025) och lager i automaten. Skrivet som ägaren genom RLS.
 */
async function seedFixture(): Promise<Fixture> {
  const owner = await createUser(`att-gora-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Att göra ${uniqueSuffix()}`);
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
    const [title, secondTitle] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Pokémon 151 Booster" },
        { ...org, name: "Surging Sparks Booster" },
      ])
      .returning();
    await tx.insert(s.purchasePrices).values([
      { ...org, titleId: title!.id, unitCostOre: 4500, validFrom: "2025-01-01" },
      { ...org, titleId: secondTitle!.id, unitCostOre: 5200, validFrom: "2025-01-01" },
    ]);
    const [source] = await tx
      .insert(s.dataSources)
      // En automatisk källa som hämtade nyss: tystnaden räknas fram till hämtningen, som på
      // Drift (sales_data_until). Med en CSV-källa och en enda automat slutar täckningen vid
      // automatens egen sista order, och då är det datalarmet som säger till, inte Att göra.
      .values({
        ...org,
        provider: "awish_grpc",
        name: "Awish",
        lastSyncedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      })
      .returning();
    const [imp] = await tx
      .insert(s.imports)
      .values({
        ...org,
        dataSourceId: source!.id,
        trigger: "upload",
        fileName: "orders.csv",
        fileSha256: "a".repeat(64),
        storagePath: `${orgId}/imports/orders.csv`,
        parserVersion: "awish-csv@1",
        rowsTotal: 2,
        rowsNew: 2,
        status: "succeeded",
      })
      .returning();
    const order = (externalId: string, rawTitle: string, titleId: string, at: string) => ({
      ...org,
      dataSourceId: source!.id,
      externalId,
      rawTitle,
      titleId,
      orderedAt: new Date(at),
      amountOre: 7900,
      paymentMethod: "card",
      machineId: machine!.id,
      importId: imp!.id,
      sourceHash: `h${externalId}`,
    });
    await tx
      .insert(s.orders)
      .values([
        order("42001", "Pokemon 151", title!.id, "2025-03-10T10:00:00Z"),
        order("42002", "Surging Sparks", secondTitle!.id, "2025-03-11T10:00:00Z"),
      ]);
    const locations = await tx.select().from(s.stockLocations);
    const central = locations.find((l) => l.organizationId === orgId && l.isCentral);
    const machineLocation = locations.find(
      (l) => l.organizationId === orgId && l.machineId === machine!.id,
    );
    await tx.insert(s.stockEvents).values([
      {
        ...org,
        locationId: machineLocation!.id,
        titleId: title!.id,
        kind: "count",
        quantity: 10,
        occurredAt: new Date("2025-03-05T08:00:00Z"),
      },
      {
        ...org,
        locationId: machineLocation!.id,
        titleId: secondTitle!.id,
        kind: "count",
        quantity: 5,
        occurredAt: new Date("2025-03-05T08:00:00Z"),
      },
    ]);
    return {
      orgId,
      owner,
      machineId: machine!.id,
      machineLocationId: machineLocation!.id,
      centralLocationId: central!.id,
      titleId: title!.id,
      secondTitleId: secondTitle!.id,
    };
  });
}

let fx: Fixture;
let owner: Viewer;
let refiller: Viewer;
let refillerUser: TestUser;
let reader: Viewer;
let otherOwner: Viewer;
let otherOwnerUser: TestUser;

async function stockOf(locationId: string, titleId: string): Promise<number> {
  const [r] = await rows<{ q: number }>(
    db(),
    sql`select coalesce(sum(quantity), 0)::int as q from public.stock_levels
        where location_id = ${locationId}::uuid and title_id = ${titleId}::uuid`,
  );
  return r?.q ?? 0;
}

beforeAll(async () => {
  fx = await seedFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
  refillerUser = await createMember(fx.orgId, "refiller");
  refiller = await viewerFor(refillerUser, fx.orgId);
  reader = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
  const other = await seedFixture();
  otherOwnerUser = other.owner;
  otherOwner = await viewerFor(other.owner, other.orgId);

  // Titel 1 tar slut (svinn) → påfyllningspunkt. En felstavad titel → dubblettpunkt.
  await asUser(fx.owner, async (tx) => {
    await tx.insert(s.stockEvents).values({
      organizationId: fx.orgId,
      locationId: fx.machineLocationId,
      titleId: fx.titleId,
      kind: "waste",
      quantity: -9,
      occurredAt: new Date("2025-03-12T08:00:00Z"),
    });
    await tx
      .insert(s.titles)
      .values({ organizationId: fx.orgId, name: "Surging Sparks Boster", series: null });
  });
});

describe("listan per roll", () => {
  it("ägaren ser påfyllning, tyst automat och dubblett", async () => {
    const kinds = (await loadTodosFor(owner, NOW)).map((t) => t.kind).sort();
    expect(kinds).toEqual(["duplicate-title", "refill", "stale-machine"]);
  });

  it("påfyllaren ser bara lagerpunkter, utan belopp", async () => {
    const todos = await loadTodosFor(refiller, NOW);
    expect(todos.map((t) => t.kind).sort()).toEqual(["refill", "stale-machine"]);
    expect(todos.every((t) => t.atStakeOre === null)).toBe(true);
  });
});

describe("dismissTodoFor / undoDismissFor", () => {
  it("bockar av, döljer punkten, loggar och kan ångras", async () => {
    const item = (await loadTodosFor(owner, NOW)).find((t) => t.kind === "stale-machine")!;
    const result = await dismissTodoFor(
      owner,
      { key: item.key, fingerprint: item.fingerprint },
      NOW,
    );
    expect(result).toMatchObject({ ok: true, data: { key: item.key } });
    expect((await loadTodosFor(owner, NOW)).some((t) => t.key === item.key)).toBe(false);
    // Samma rad gäller påfyllaren (lagerpunkt), så räknaren stämmer för alla.
    expect((await loadTodosFor(refiller, NOW)).some((t) => t.key === item.key)).toBe(false);

    const [row] = await rows<{ dismissed_by: string; fingerprint: string; title: string }>(
      db(),
      sql`select dismissed_by, fingerprint, title from public.todo_dismissals
          where organization_id = ${fx.orgId}::uuid and todo_key = ${item.key}`,
    );
    // Rubriken sparas från serverns punkt (för listan Avbockade).
    expect(row).toEqual({
      dismissed_by: fx.owner.id,
      fingerprint: item.fingerprint,
      title: item.title,
    });
    const current = new Set((await loadTodosFor(owner, NOW)).map((t) => t.key));
    const dismissed = await loadDismissedFor(owner, current, NOW);
    expect(dismissed).toEqual([
      expect.objectContaining({ key: item.key, title: item.title, dismissedBy: "dig" }),
    ]);
    const audit = await rows(
      db(),
      sql`select 1 from public.audit_log
          where organization_id = ${fx.orgId}::uuid and table_name = 'todo_dismissals'`,
    );
    expect(audit.length).toBeGreaterThan(0);

    expect(await undoDismissFor(owner, { key: item.key })).toEqual({ ok: true });
    expect((await loadTodosFor(owner, NOW)).some((t) => t.key === item.key)).toBe(true);
    // Andra gången finns ingen rad att ta bort: svaret säger det.
    expect(await undoDismissFor(owner, { key: item.key })).toMatchObject({ ok: false });
    expect(await loadDismissedFor(owner, new Set(), NOW)).toEqual([]);
  });

  it("vägrar en punkt som inte finns eller har ändrats", async () => {
    const item = (await loadTodosFor(owner, NOW))[0]!;
    const changed = await dismissTodoFor(owner, { key: item.key, fingerprint: "annat" }, NOW);
    expect(changed.ok).toBe(false);
    const missing = await dismissTodoFor(owner, { key: "refill:x:y", fingerprint: "f" }, NOW);
    expect(missing.ok).toBe(false);
    const junk = await dismissTodoFor(owner, { key: 1 }, NOW);
    expect(junk.ok).toBe(false);
  });

  it("påfyllaren bockar av lagerpunkter men kan inte skriva andra nycklar", async () => {
    const item = (await loadTodosFor(refiller, NOW)).find((t) => t.kind === "refill")!;
    const result = await dismissTodoFor(
      refiller,
      { key: item.key, fingerprint: item.fingerprint },
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(await undoDismissFor(refiller, { key: item.key })).toEqual({ ok: true });

    // Direkt mot databasen: RLS stoppar en nyckel som inte gäller lagret.
    const dup = (await loadTodosFor(owner, NOW)).find((t) => t.kind === "duplicate-title")!;
    const outcome = await asUser(refillerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into public.todo_dismissals (organization_id, todo_key, fingerprint, dismissed_by)
                       values (${fx.orgId}::uuid, ${dup.key}, ${dup.fingerprint}, ${refillerUser.id}::uuid)`),
      ),
    );
    expect(outcome.ok).toBe(false);
    // Och påfyllaren kan inte se ägarens avbockning av en sådan punkt.
    await dismissTodoFor(owner, { key: dup.key, fingerprint: dup.fingerprint }, NOW);
    const seen = await asUser(refillerUser, (tx) =>
      rows(tx, sql`select todo_key from public.todo_dismissals where todo_key = ${dup.key}`),
    );
    expect(seen).toEqual([]);
    // Ångra en sådan nyckel vägras (ingen tom "ok"), och listan Avbockade visar den inte.
    expect(await undoDismissFor(refiller, { key: dup.key })).toMatchObject({ ok: false });
    expect((await loadDismissedFor(refiller, new Set(), NOW)).map((d) => d.key)).toEqual([]);
    expect((await loadDismissedFor(owner, new Set(), NOW)).map((d) => d.key)).toEqual([dup.key]);
    expect(await undoDismissFor(owner, { key: dup.key })).toEqual({ ok: true });
  });

  it("läsaren och en annan organisation får inte bocka av", async () => {
    const item = (await loadTodosFor(owner, NOW))[0]!;
    const input = { key: item.key, fingerprint: item.fingerprint };
    expect((await dismissTodoFor(reader, input, NOW)).ok).toBe(false);
    expect((await undoDismissFor(reader, { key: item.key })).ok).toBe(false);
    // En annan organisations ägare: punkten finns inte i hens lista.
    expect((await dismissTodoFor(otherOwner, input, NOW)).ok).toBe(false);
    const leaked = await asUser(otherOwnerUser, (tx) =>
      rows(tx, sql`select 1 from public.todo_dismissals where organization_id = ${fx.orgId}::uuid`),
    );
    expect(leaked).toEqual([]);
  });
});

describe("registerRefillFor", () => {
  it("vägrar ta fler pack än centrallagret har", async () => {
    const result = await registerRefillFor(refiller, {
      machineId: fx.machineId,
      titleId: fx.titleId,
      quantity: 5,
      fromWarehouse: true,
    });
    expect(result).toEqual({
      ok: false,
      error: "Hemma har bara 0 pack av Pokémon 151 Booster.",
    });
  });

  it("validerar antal och roll", async () => {
    const base = { machineId: fx.machineId, titleId: fx.titleId, fromWarehouse: false };
    expect((await registerRefillFor(refiller, { ...base, quantity: 0 })).ok).toBe(false);
    expect((await registerRefillFor(refiller, { ...base, quantity: 1.5 })).ok).toBe(false);
    expect((await registerRefillFor(reader, { ...base, quantity: 3 })).ok).toBe(false);
    expect((await registerRefillFor(otherOwner, { ...base, quantity: 3 })).ok).toBe(false);
  });

  it("påfyllaren fyller på från centrallagret; punkten försvinner", async () => {
    await asUser(fx.owner, (tx) =>
      tx.insert(s.stockEvents).values({
        organizationId: fx.orgId,
        locationId: fx.centralLocationId,
        titleId: fx.titleId,
        kind: "receipt",
        quantity: 20,
      }),
    );
    const machineBefore = await stockOf(fx.machineLocationId, fx.titleId);
    const centralBefore = await stockOf(fx.centralLocationId, fx.titleId);
    const result = await registerRefillFor(refiller, {
      machineId: fx.machineId,
      titleId: fx.titleId,
      quantity: 8,
      fromWarehouse: true,
    });
    expect(result).toEqual({ ok: true, data: { quantity: 8 } });
    expect(await stockOf(fx.machineLocationId, fx.titleId)).toBe(machineBefore + 8);
    expect(await stockOf(fx.centralLocationId, fx.titleId)).toBe(centralBefore - 8);

    const events = await rows<{ kind: string; performed_by: string }>(
      db(),
      sql`select kind::text, performed_by from public.stock_events
          where organization_id = ${fx.orgId}::uuid and performed_by = ${refillerUser.id}::uuid`,
    );
    expect(events.map((e) => e.kind).sort()).toEqual(["adjustment", "refill"]);
    expect((await loadTodosFor(refiller, NOW)).some((t) => t.kind === "refill")).toBe(false);
  });
});

describe("mergeTitlesFor", () => {
  it("bara ägare och admin, och bara ett föreslaget par", async () => {
    const dup = (await loadTodosFor(owner, NOW)).find((t) => t.kind === "duplicate-title")!;
    const params = dup.action!.params as { fromTitleId: string; intoTitleId: string };
    expect((await mergeTitlesFor(refiller, params, NOW)).ok).toBe(false);
    expect((await mergeTitlesFor(reader, params, NOW)).ok).toBe(false);
    const notPair = await mergeTitlesFor(
      owner,
      { fromTitleId: fx.secondTitleId, intoTitleId: fx.titleId },
      NOW,
    );
    expect(notPair.ok).toBe(false);
  });

  it("slår ihop åt det håll användaren valt och behåller originaldata", async () => {
    const dup = (await loadTodosFor(owner, NOW)).find((t) => t.kind === "duplicate-title")!;
    const { fromTitleId, intoTitleId } = dup.action!.params as {
      fromTitleId: string;
      intoTitleId: string;
    };
    // Omvänd riktning: behåll det namn som föreslogs att slås ihop.
    const result = await mergeTitlesFor(
      owner,
      { fromTitleId: intoTitleId, intoTitleId: fromTitleId },
      NOW,
    );
    expect(result.ok).toBe(true);
    const [merged] = await rows<{ merged_into_id: string | null }>(
      db(),
      sql`select merged_into_id from public.titles where id = ${intoTitleId}::uuid`,
    );
    expect(merged?.merged_into_id).toBe(fromTitleId);
    const raw = await rows<{ raw_title: string }>(
      db(),
      sql`select raw_title from public.orders where organization_id = ${fx.orgId}::uuid order by external_id`,
    );
    expect(raw.map((r) => r.raw_title)).toEqual(["Pokemon 151", "Surging Sparks"]);
    expect((await loadTodosFor(owner, NOW)).some((t) => t.kind === "duplicate-title")).toBe(false);
  });
});

describe("utgångna titlar (sortimentet) i Att göra", () => {
  // Sist i filen: lägger till sortimentet för fixturens automat.
  it("ger ingen påfyllningspunkt för en titel som gått ur sortimentet, som Lager och Drift", async () => {
    const refillKey = `refill:${fx.machineId}:${fx.titleId}`;
    // Titeln tar slut igen (påfyllningen ovan fyllde på den): svinn ner till 0.
    const left = await stockOf(fx.machineLocationId, fx.titleId);
    if (left > 0) {
      await asUser(fx.owner, (tx) =>
        tx.insert(s.stockEvents).values({
          organizationId: fx.orgId,
          locationId: fx.machineLocationId,
          titleId: fx.titleId,
          kind: "waste",
          quantity: -left,
          occurredAt: new Date("2025-03-14T08:00:00Z"),
        }),
      );
    }
    expect((await loadRankedTodoStateFor(owner, NOW)).items.map((t) => t.key)).toContain(refillKey);
    // Titeln gick ur automatens sortiment den 1 mars; resten säljs ut.
    await db().execute(
      sql`insert into public.machine_slots (organization_id, machine_id, title_id, slots, valid_from, valid_to)
          values (${fx.orgId}::uuid, ${fx.machineId}::uuid, ${fx.titleId}::uuid, 1, '2025-01-01', '2025-03-01')`,
    );
    for (const viewer of [owner, refiller]) {
      const state = await loadRankedTodoStateFor(viewer, NOW);
      expect(state.items.map((t) => t.key)).not.toContain(refillKey);
      expect(state.dismissed.map((t) => t.key)).not.toContain(refillKey);
    }
    // Den andra titeln (inget registrerat sortiment) påverkas inte.
    const other = (await loadTodosFor(owner, NOW)).filter(
      (t) => t.kind === "refill" && t.key !== refillKey,
    );
    const ranked = (await loadRankedTodoStateFor(owner, NOW)).items.filter(
      (t) => t.kind === "refill",
    );
    expect(ranked.map((t) => t.key)).toEqual(other.map((t) => t.key));
  });
});
