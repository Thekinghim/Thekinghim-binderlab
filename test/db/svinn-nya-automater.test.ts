/**
 * Managerpaket 4 och 7 mot testdatabasen:
 * - svinnkontrollen (src/server/data/shrinkage.ts): påfyllt, sålt och räknat saldo per
 *   automat och titel, avvikelsen per räkning summerad över perioden, behörighet;
 * - nya automater från Awish (src/server/machines/new-machines.ts): listan, Koppla,
 *   "Inte vår" med Ångra och guiden "Ny butik", per roll.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { listOrganizationsFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { loadShrinkageFor } from "@/server/data/shrinkage";
import {
  connectNewMachineFor,
  createStoreGuideFor,
  ignoreNewMachineFor,
  loadNewMachinesFor,
  unignoreNewMachineFor,
} from "@/server/machines/new-machines";

import { asUser, createMember, db, one, rows, type TestUser } from "./helpers";
import { awishCsv, mapMachine, setupImportOrg, type ImportFixture } from "./import-fixtures";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const PERIOD = { start: "2026-10-10", end: "2026-10-20" } as const;

describe("svinnkontroll", () => {
  let f: ImportFixture;
  let machineId: string;
  let locationId: string;
  let booster: string;
  let sparks: string;
  let owner: Viewer;

  beforeAll(async () => {
    f = await setupImportOrg();
    owner = await viewerFor(f.owner, f.orgId);
    machineId = await mapMachine(f, "BL-001 ICA Lund", "BL-001");
    // Tre köp av Booster i perioden (13 okt. svensk tid).
    const r = await f.run(
      awishCsv([
        { no: "1", name: "Booster", time: "2026-10-13 18:00:00" },
        { no: "2", name: "Booster", time: "2026-10-13 18:10:00" },
        { no: "3", name: "Booster", time: "2026-10-13 18:20:00" },
      ]),
    );
    expect(r.summary?.new).toBe(3);
    const loc = await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where machine_id = ${machineId}::uuid`,
    );
    locationId = loc.id;
    booster = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.titles where organization_id = ${f.orgId}::uuid and name = 'Booster'`,
      )
    ).id;
    await asUser(f.owner, async (tx) => {
      sparks = (
        await one<{ id: string }>(
          tx,
          sql`insert into public.titles (organization_id, name) values (${f.orgId}::uuid, 'Sparks')
              returning id`,
        )
      ).id;
      await tx.execute(
        sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
            values (${f.orgId}::uuid, ${booster}::uuid, 4000, '2026-01-01')`,
      );
      const ev = (title: string, kind: string, qty: number, at: string) =>
        tx.execute(
          sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
              values (${f.orgId}::uuid, ${locationId}::uuid, ${title}::uuid, ${kind}::public.stock_event_kind, ${qty}, ${at}::timestamptz)`,
        );
      // Booster: 10 före perioden, 3 sålda, 5 påfyllda, räknat 9 → 3 saknas.
      await ev(booster, "count", 10, "2026-10-01T10:00:00Z");
      await ev(booster, "refill", 5, "2026-10-14T08:00:00Z");
      await ev(booster, "count", 9, "2026-10-14T12:00:00Z");
      // Sparks: Awish ser påfyllningen (+10) före registreringen i appen (+10): netto 0.
      await ev(sparks, "count", 10, "2026-10-01T10:00:00Z");
      await ev(sparks, "count", 20, "2026-10-12T10:00:00Z");
      await ev(sparks, "refill", 10, "2026-10-12T10:20:00Z");
      await ev(sparks, "count", 20, "2026-10-12T11:00:00Z");
    });
  });

  it("räknar påfyllt, sålt, saldo och avvikelse per titel", async () => {
    const result = await loadShrinkageFor(owner, PERIOD);
    const b = result.find((r) => r.titleId === booster);
    expect(b).toMatchObject({
      machineId,
      refilled: 5,
      sold: 3,
      deviation: -3,
      compared: 1,
      opening: 10,
      closing: 9,
      unitCostOre: 4000,
    });
    const s = result.find((r) => r.titleId === sparks);
    expect(s).toMatchObject({ refilled: 10, sold: 0, deviation: 0, compared: 2, closing: 20 });
  });

  it("räkningar före perioden räknas inte; första räkningen jämförs aldrig", async () => {
    // Bara 1 okt.: ingen rörelse i perioden → inga rader.
    const before = await loadShrinkageFor(owner, { start: "2026-10-01", end: "2026-10-01" });
    expect(before.every((r) => r.compared === 0)).toBe(true);
    // Perioden från 13 okt.: Sparks har ingen räkning efter → okänd avvikelse (null).
    const late = await loadShrinkageFor(owner, { start: "2026-10-13", end: "2026-10-20" });
    expect(late.find((r) => r.titleId === sparks)).toBeUndefined();
    expect(late.find((r) => r.titleId === booster)).toMatchObject({ deviation: -3, sold: 3 });
  });

  it("läsaren får läsa, påfyllaren inte (inköpspriset är ekonomi)", async () => {
    const reader = await createMember(f.orgId, "viewer");
    const refiller = await createMember(f.orgId, "refiller");
    expect(await loadShrinkageFor(await viewerFor(reader, f.orgId), PERIOD)).toHaveLength(2);
    await expect(loadShrinkageFor(await viewerFor(refiller, f.orgId), PERIOD)).rejects.toThrow();
  });
});

describe("nya automater från Awish", () => {
  let f: ImportFixture;
  let owner: Viewer;
  let storeId: string;
  let sourceId: string;

  beforeAll(async () => {
    f = await setupImportOrg();
    owner = await viewerFor(f.owner, f.orgId);
    await mapMachine(f, "BL-001 ICA Lund", "BL-001");
    await f.run(
      awishCsv([
        { no: "1", machine: "Nya hallen", time: "2026-10-20 12:00:00" },
        { no: "2", machine: "Nya hallen", time: "2026-10-22 12:00:00" },
        { no: "3", machine: "Tredje", time: "2026-10-22 13:00:00" },
      ]),
    );
    storeId = (
      await asUser(f.owner, (tx) =>
        one<{ id: string }>(
          tx,
          sql`insert into public.stores (organization_id, name) values (${f.orgId}::uuid, 'Sega gubben')
              returning id`,
        ),
      )
    ).id;
  });

  it("listar okopplade automater med köp och föreslagen kod", async () => {
    const state = await loadNewMachinesFor(owner);
    const nya = state.machines.find((m) => m.name === "Nya hallen");
    expect(nya).toMatchObject({ orders: 2, firstOrderDate: "2026-10-20", suggestedCode: "BL-002" });
    expect(state.machines.find((m) => m.name === "Tredje")?.suggestedCode).toBe("BL-003");
    expect(state.stores.map((s) => s.name)).toContain("Sega gubben");
    sourceId = nya!.id;
  });

  it("läsare och påfyllare ser inget och kan inte koppla", async () => {
    const reader = await viewerFor(await createMember(f.orgId, "viewer"), f.orgId);
    const refiller = await viewerFor(await createMember(f.orgId, "refiller"), f.orgId);
    expect((await loadNewMachinesFor(reader)).machines).toEqual([]);
    expect(
      await connectNewMachineFor(refiller, { sourceMachineId: sourceId, storeId }, "2026-11-03"),
    ).toMatchObject({ ok: false });
    expect((await ignoreNewMachineFor(reader, { sourceMachineId: sourceId })).ok).toBe(false);
  });

  it("Inte vår döljer automaten och Ångra visar den igen", async () => {
    expect((await ignoreNewMachineFor(owner, { sourceMachineId: sourceId })).ok).toBe(true);
    expect((await loadNewMachinesFor(owner)).machines.some((m) => m.id === sourceId)).toBe(false);
    expect((await unignoreNewMachineFor(owner, { sourceMachineId: sourceId })).ok).toBe(true);
    expect((await loadNewMachinesFor(owner)).machines.some((m) => m.id === sourceId)).toBe(true);
  });

  it("Koppla skapar automat, placering från första köpet och ger köpen automaten", async () => {
    const r = await connectNewMachineFor(
      owner,
      { sourceMachineId: sourceId, storeId },
      "2026-11-03",
    );
    expect(r).toMatchObject({ ok: true, data: { code: "BL-002", orders: 2 } });
    const machineId = r.ok ? r.data!.machineId : "";
    const m = await one<{ name: string; active_from: string }>(
      db(),
      sql`select name, active_from::text from public.machines where id = ${machineId}::uuid`,
    );
    expect(m).toEqual({ name: "Nya hallen", active_from: "2026-10-20" });
    const p = await rows<{ store_id: string; valid_from: string }>(
      db(),
      sql`select store_id, valid_from::text from public.machine_placements where machine_id = ${machineId}::uuid`,
    );
    expect(p).toEqual([{ store_id: storeId, valid_from: "2026-10-20" }]);
    const left = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.orders
          where source_machine_id = ${sourceId}::uuid and machine_id is null`,
    );
    expect(left.n).toBe(0);
    expect((await loadNewMachinesFor(owner)).machines.some((m) => m.id === sourceId)).toBe(false);
    // Två gånger går inte.
    const again = await connectNewMachineFor(
      owner,
      { sourceMachineId: sourceId, storeId },
      "2026-11-03",
    );
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/redan kopplad/) });
  });

  it("guiden skapar butik, 50/50-avtal och kopplar automaten i ett steg", async () => {
    const tredje = (await loadNewMachinesFor(owner)).machines.find((m) => m.name === "Tredje")!;
    const r = await createStoreGuideFor(
      owner,
      {
        store: { name: "Hörnkiosken", address: "Storgatan 2", city: "Lund" },
        terms: { preset: "split" },
        machine: { kind: "awish", sourceMachineId: tredje.id },
      },
      "2026-11-03",
    );
    expect(r).toMatchObject({ ok: true, data: { machineCode: "BL-003" } });
    const id = r.ok ? r.data!.storeId : "";
    const a = await one<{ commission_bp: number; commission_base: string; valid_from: string }>(
      db(),
      sql`select commission_bp, commission_base::text, valid_from::text
          from public.store_agreements where store_id = ${id}::uuid`,
    );
    expect(a).toEqual({
      commission_bp: 5000,
      commission_base: "profit_after_costs",
      valid_from: "2026-10-22",
    });
  });

  it("guiden: fast hyra och ny automat; fel villkor sparar ingenting", async () => {
    const r = await createStoreGuideFor(
      owner,
      {
        store: { name: "Hyresbutiken" },
        terms: { preset: "rent", rent: "750" },
        machine: { kind: "new" },
      },
      "2026-11-03",
    );
    expect(r).toMatchObject({ ok: true, data: { machineCode: "BL-004" } });
    const id = r.ok ? r.data!.storeId : "";
    const a = await one<{ commission_bp: number | null; monthly_rent_ore: number }>(
      db(),
      sql`select commission_bp, monthly_rent_ore::int as monthly_rent_ore from public.store_agreements where store_id = ${id}::uuid`,
    );
    expect(a).toEqual({ commission_bp: null, monthly_rent_ore: 75000 });

    const bad = await createStoreGuideFor(
      owner,
      { store: { name: "Ingen andel" }, terms: { preset: "sales" }, machine: null },
      "2026-11-03",
    );
    expect(bad.ok).toBe(false);
    const none = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.stores
          where organization_id = ${f.orgId}::uuid and name = 'Ingen andel'`,
    );
    expect(none.n).toBe(0);
  });

  it("Koppla skapar ingen dubblett när automaten redan finns med samma maskinnummer", async () => {
    const src = await one<{ data_source_id: string }>(
      db(),
      sql`select data_source_id from public.source_machines where id = ${sourceId}::uuid`,
    );
    const dup = await one<{ id: string }>(
      db(),
      sql`insert into public.source_machines
            (organization_id, data_source_id, external_id, external_name, external_device_no)
          values (${f.orgId}::uuid, ${src.data_source_id}::uuid, 'ext-dubblett', 'Gamla', 'SN-77')
          returning id`,
    );
    const existing = await asUser(f.owner, (tx) =>
      one<{ id: string; code: string }>(
        tx,
        sql`insert into public.machines (organization_id, code, name, serial)
            values (${f.orgId}::uuid, 'BL-077', 'Redan här', ' sn-77 ')
            returning id, code`,
      ),
    );
    const listed = (await loadNewMachinesFor(owner)).machines.find((m) => m.id === dup.id);
    expect(listed?.suggestedCode).toBe("BL-077");
    const before = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.machines where organization_id = ${f.orgId}::uuid`,
    );
    const r = await connectNewMachineFor(owner, { sourceMachineId: dup.id, storeId }, "2026-11-03");
    expect(r).toMatchObject({ ok: true, data: { machineId: existing.id, code: "BL-077" } });
    const after = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.machines where organization_id = ${f.orgId}::uuid`,
    );
    expect(after.n).toBe(before.n);
    const linked = await one<{ machine_id: string }>(
      db(),
      sql`select machine_id from public.source_machines where id = ${dup.id}::uuid`,
    );
    expect(linked.machine_id).toBe(existing.id);
  });
});
