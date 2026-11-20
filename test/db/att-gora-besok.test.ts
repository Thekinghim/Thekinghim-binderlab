/**
 * Besök i Att göra (T2-1) mot testdatabasen: besöksplanen som Att göra och Hem läser
 * (loadTodoVisitPlanFor), och att påfyllningarna för en automat räknas som en sak.
 *
 * En organisation med en automat i en butik med adress, två titlar som säljer 1 pack per
 * dag och har 2 pack kvar. "Nu" är onsdag 11 november 2026 10:00 svensk tid.
 *
 *   1. Påfyllaren (utan ekonomi) får två påfyllningspunkter, som blir ETT besök med dagen
 *      ur besöksplanen. Menyns räknare (loadTodoCountFor) säger 1.
 *   2. Planen innehåller inga belopp och butikens adress följer med (Google Maps).
 *   3. Ägaren får samma plan. En användare utanför organisationen får ingenting.
 */

import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_noStore: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

import { countWithVisits, groupVisits } from "@/analytics/todos";
import { buildPage } from "@/app/(app)/att-gora/_lib/model";
import * as s from "@/db/schema";
import { listOrganizationsFor } from "@/server/access";
import { loadTodoStateFor, type Viewer } from "@/server/data/core/loaders";
import { loadTodoCountFor, loadTodoVisitPlanFor } from "@/server/data/todos";

import { asUser, createMember, createOrg, createUser, type TestUser } from "./helpers";

const NOW = new Date("2026-11-11T09:00:00Z");
const TODAY = "2026-11-11";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let orgId: string;
let owner: Viewer;
let refiller: Viewer;
let outsider: Viewer;
let machineId: string;
let storeId: string;

async function seed(): Promise<{
  orgId: string;
  owner: TestUser;
  machineId: string;
  storeId: string;
}> {
  const user = await createUser(`besok-agare-${randomUUID()}@test.binderlab.se`);
  const id = await createOrg(user, "Besökstest");
  const org = { organizationId: id };
  const fx = await asUser(user, async (tx) => {
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Sega gubben", address: "Storgatan 1", city: "Lund" })
      .returning();
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-003", name: "Automat 3", activeFrom: "2026-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2026-01-01" });
    const titles = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Black Bolt" },
        { ...org, name: "Surging Sparks" },
      ])
      .returning();
    const locations = await tx.select().from(s.stockLocations);
    const location = locations.find((l) => l.organizationId === id && l.machineId === machine!.id);
    // Inräknat 16 pack den 27 oktober.
    await tx.insert(s.stockEvents).values(
      titles.map((t) => ({
        ...org,
        locationId: location!.id,
        titleId: t.id,
        kind: "count" as const,
        quantity: 16,
        occurredAt: new Date("2026-10-27T07:00:00Z"),
      })),
    );
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const [sourceMachine] = await tx
      .insert(s.sourceMachines)
      .values({
        ...org,
        dataSourceId: source!.id,
        externalId: "AW-3",
        externalName: "Automat 3",
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
        fileSha256: "c".repeat(64),
        storagePath: `${id}/imports/orders.csv`,
        parserVersion: "awish-csv@1",
        rowsTotal: 28,
        rowsNew: 28,
        status: "succeeded",
      })
      .returning();
    // Försäljning: 1 pack per dag och titel 28 okt.–10 nov. (14 dagar): 2 pack kvar.
    const orders = [];
    for (let d = 0; d < 14; d++) {
      for (const t of titles) {
        orders.push({
          ...org,
          dataSourceId: source!.id,
          externalId: `B-${d}-${t.name}`,
          rawTitle: t.name,
          titleId: t.id,
          orderedAt: new Date(Date.UTC(2026, 9, 28 + d, 11, 0, 0)),
          amountOre: 10_000,
          paymentMethod: "card",
          sourceMachineId: sourceMachine!.id,
          machineId: machine!.id,
          importId: imp!.id,
          sourceHash: `besok-${d}-${t.id}`,
        });
      }
    }
    await tx.insert(s.orders).values(orders);
    return { machineId: machine!.id, storeId: store!.id };
  });
  return { orgId: id, owner: user, machineId: fx.machineId, storeId: fx.storeId };
}

beforeAll(async () => {
  const fx = await seed();
  orgId = fx.orgId;
  machineId = fx.machineId;
  storeId = fx.storeId;
  owner = await viewerFor(fx.owner, orgId);
  refiller = await viewerFor(await createMember(orgId, "refiller"), orgId);
  const other = await seed();
  outsider = await viewerFor(other.owner, other.orgId);
}, 120_000);

describe("besök i Att göra", () => {
  it("påfyllaren: två påfyllningar blir ett besök med besöksplanens dag", async () => {
    const [state, visits] = await Promise.all([
      loadTodoStateFor(refiller, NOW),
      loadTodoVisitPlanFor(refiller, NOW),
    ]);
    const refills = state.items.filter((t) => t.kind === "refill");
    expect(refills).toHaveLength(2);
    const stop = visits.plan.days.flatMap((d) => d.stops).find((x) => x.machineId === machineId);
    expect(stop).toBeDefined();
    const rows = groupVisits(state.items, visits.plan, TODAY);
    const visit = rows.flatMap((r) => (r.type === "visit" ? [r.visit] : []));
    expect(visit).toHaveLength(1);
    // Packen på raden: packlistans antal för besökets titlar (inte allt planen fyller upp).
    const refillTitles = new Set(refills.map((t) => t.key.split(":")[2]));
    const packs = stop!.packs
      .filter((p) => refillTitles.has(p.titleId))
      .reduce((n, p) => n + p.quantity, 0);
    expect(visit[0]).toMatchObject({ machineId, needBy: stop!.needBy, packs });
    expect(visit[0]!.items).toHaveLength(2);
    // Menyns räknare: ett besök är en sak.
    expect(countWithVisits(state.items)).toBe(state.items.length - 1);
    expect(await loadTodoCountFor(refiller, NOW)).toBe(countWithVisits(state.items));
  });

  it("sidan: en rad, utan kronor för påfyllaren, med vägbeskrivning till butiken", async () => {
    const [state, visits] = await Promise.all([
      loadTodoStateFor(refiller, NOW),
      loadTodoVisitPlanFor(refiller, NOW),
    ]);
    const page = buildPage({
      todos: state.items,
      role: "refiller",
      economy: false,
      titles: [],
      machines: [{ id: machineId, name: "Automat 3", code: "BL-003", storeId }],
      machineStock: [],
      warehouse: null,
      scope: { storeId: null, machineId: null },
      computedAt: "10:00",
      today: TODAY,
      visitPlan: visits.plan,
      places: visits.places,
    });
    const row = page.groups.flatMap((g) => g.rows).find((r) => r.type === "visit");
    expect(row?.type).toBe("visit");
    if (row?.type !== "visit") return;
    expect(row.visit.title).toMatch(/^Åk till BL‑003 (i dag|senast .+)\.$/);
    expect(row.visit.facts).not.toMatch(/kr/);
    expect(row.visit.mapsHref).toContain("Storgatan");
    expect(JSON.stringify(visits.plan)).not.toMatch(/Ore"|\d\s?kr\b/);
  });

  it("ägaren får samma dag som påfyllaren", async () => {
    const [a, b] = await Promise.all([
      loadTodoVisitPlanFor(owner, NOW),
      loadTodoVisitPlanFor(refiller, NOW),
    ]);
    const days = (p: typeof a) =>
      p.plan.days.flatMap((d) => d.stops.map((x) => [d.date, x.machineId, x.needBy, x.totalPacks]));
    expect(days(a)).toEqual(days(b));
    expect(days(a).length).toBe(1);
  });

  it("en användare utanför organisationen får ingen plan för den", async () => {
    const intruder: Viewer = { user: outsider.user, organization: owner.organization };
    const result = await loadTodoVisitPlanFor(intruder, NOW).then(
      (v) => v,
      () => null,
    );
    expect(result?.plan.days ?? []).toEqual([]);
    expect([...(result?.places.keys() ?? [])]).toEqual([]);
  });
});
