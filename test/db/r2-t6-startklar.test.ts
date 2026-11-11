/**
 * Runda 2, T6-1 mot testdatabasen: Startklar per automat (src/server/onboarding/
 * machine-ready-load.ts) räknad ur datan under RLS, per roll, och att en ny automat ärver
 * "Ansvarig" och "Fylls på från" från senaste automaten (src/server/machines/new-machines.ts).
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { listOrganizationsFor } from "@/server/access";
import { loadStartklarFor } from "@/server/data/todos";
import type { Viewer } from "@/server/data/core/loaders";
import { connectNewMachineFor } from "@/server/machines/new-machines";
import { loadMachineReadinessFor } from "@/server/onboarding/machine-ready-load";
import type { MachineReadiness } from "@/server/onboarding/machine-ready";

import {
  asPostgres,
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  uniqueSuffix,
  type TestUser,
} from "./helpers";
import { awishCsv, mapMachine, setupImportOrg, type ImportFixture } from "./import-fixtures";

const session = (u: TestUser) => ({ userId: u.id, email: u.email });

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = session(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

function byCode(list: readonly MachineReadiness[], code: string): MachineReadiness {
  const found = list.find((r) => r.code === code);
  if (!found) throw new Error(`${code} saknas i listan`);
  return found;
}

const open = (r: MachineReadiness) => r.steps.filter((s) => !s.done).map((s) => s.id);

describe("Startklar per automat", () => {
  let f: ImportFixture;
  let owner: Viewer;
  let refiller: TestUser;
  let reader: TestUser;
  let storeId: string;
  let sourceId: string;
  let firstMachine: string;
  let warehouseId: string;
  let newMachine: string;
  let titleId: string;

  beforeAll(async () => {
    f = await setupImportOrg();
    owner = await viewerFor(f.owner, f.orgId);
    refiller = await createMember(f.orgId, "refiller");
    reader = await createMember(f.orgId, "viewer");
    firstMachine = await mapMachine(f, "BL-001 ICA Lund", "BL-001");
    await f.run(
      awishCsv([
        { no: "1", machine: "Nya hallen", time: "2026-10-20 12:00:00" },
        { no: "2", machine: "Nya hallen", time: "2026-10-22 12:00:00" },
      ]),
    );
    storeId = (
      await asUser(f.owner, (tx) =>
        one<{ id: string }>(
          tx,
          sql`insert into public.stores (organization_id, name)
              values (${f.orgId}::uuid, 'Sega gubben') returning id`,
        ),
      )
    ).id;
    sourceId = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.source_machines
            where organization_id = ${f.orgId}::uuid and external_name = 'Nya hallen'`,
      )
    ).id;
    // Första automaten: påfyllaren är ansvarig och den fylls på från Kontoret.
    warehouseId = (
      await asPostgres((tx) =>
        one<{ id: string }>(
          tx,
          sql`insert into public.stock_locations (organization_id, kind, name)
              values (${f.orgId}::uuid, 'warehouse', 'Kontoret') returning id`,
        ),
      )
    ).id;
    await asUser(f.owner, async (tx) => {
      await tx.execute(
        sql`update public.machines set responsible_user_id = ${refiller.id}::uuid
            where id = ${firstMachine}::uuid`,
      );
      await tx.execute(
        sql`select public.set_refill_source(${f.orgId}::uuid, ${firstMachine}::uuid,
              ${warehouseId}::uuid)`,
      );
    });
  });

  it("Koppla: den nya automaten ärver ansvarig och Fylls på från", async () => {
    const r = await connectNewMachineFor(
      owner,
      { sourceMachineId: sourceId, storeId },
      "2026-11-03",
    );
    expect(r).toMatchObject({ ok: true, data: { code: "BL-002", orders: 2 } });
    newMachine = r.ok ? r.data!.machineId : "";
    const m = await one<{ responsible_user_id: string | null; refill_source_id: string | null }>(
      db(),
      sql`select m.responsible_user_id, loc.refill_source_id
          from public.machines m
          left join public.stock_locations loc
            on loc.organization_id = m.organization_id and loc.machine_id = m.id
          where m.id = ${newMachine}::uuid`,
    );
    expect(m).toEqual({ responsible_user_id: refiller.id, refill_source_id: warehouseId });
  });

  it("en automat som bara finns i importerade filer väntar inte på Awish", async () => {
    // Källan är en fil (awish_csv): ingen läser facken, så lagret läggs in för hand.
    const r = byCode(await loadMachineReadinessFor(owner.user, f.orgId), "BL-002");
    expect(r.total).toBe(6);
    expect(r.steps.find((s) => s.id === "fack")?.label).toBe("Lagret är inlagt");
    expect(r.steps.some((s) => s.id === "antal")).toBe(false);
    // Resten av testet: den direkta Awish-kopplingen, som läser facken.
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.data_sources set provider = 'awish_grpc'
            where organization_id = ${f.orgId}::uuid`,
      ),
    );
  });

  it("nykopplad automat: butik och första köp klara, avtalet är nästa", async () => {
    const r = byCode(await loadMachineReadinessFor(owner.user, f.orgId), "BL-002");
    expect(r.machineId).toBe(newMachine);
    expect(r.total).toBe(7);
    expect(open(r)).toEqual(["avtal", "fack", "antal", "pris", "kostnad"]);
    expect(r.headline).toBe("BL-002: 2 av 7 klart. Nästa: lägg in avtalet.");
    expect(r.next?.href).toBe(`/butiker/${storeId}#ersattning`);
    // Raden i Att göra gäller bara nya automater: BL-002 (första köpet nyss) och BL-001
    // (inget köp än) är båda med.
    expect(r.isNew).toBe(true);
    expect((await loadStartklarFor(owner))?.machines).toBe(2);
    expect(r.left?.replace(/ /g, " ")).toBe("5 saker kvar");
  });

  it("varje sak som läggs in bockar av sitt steg, tills listan är klar", async () => {
    const load = async () => byCode(await loadMachineReadinessFor(owner.user, f.orgId), "BL-002");

    await asUser(f.owner, (tx) =>
      tx.execute(
        sql`insert into public.store_agreements
              (organization_id, store_id, valid_from, commission_bp, commission_base)
            values (${f.orgId}::uuid, ${storeId}::uuid, '2026-10-01', 5000, 'profit_after_costs')`,
      ),
    );
    expect(open(await load())).toEqual(["fack", "antal", "pris", "kostnad"]);
    // Inget annat att göra själv än kostnaden: den blir nästa, före det som bara går att vänta på.
    expect((await load()).next?.id).toBe("kostnad");

    // Awish läser facken: en titel med antal per fack.
    titleId = (
      await asUser(f.owner, (tx) =>
        one<{ id: string }>(
          tx,
          sql`insert into public.titles (organization_id, name)
              values (${f.orgId}::uuid, 'Pokémon 151') returning id`,
        ),
      )
    ).id;
    await asPostgres(async (tx) => {
      await tx.execute(
        sql`update public.stock_locations set awish_synced_at = now()
            where organization_id = ${f.orgId}::uuid and machine_id = ${newMachine}::uuid`,
      );
      await tx.execute(
        sql`insert into public.machine_slot_capacity
              (organization_id, machine_id, title_id, capacity, channels, synced_at)
            values (${f.orgId}::uuid, ${newMachine}::uuid, ${titleId}::uuid, 14, '{A1}', now())`,
      );
    });
    const afterRead = await load();
    expect(open(afterRead)).toEqual(["pris", "kostnad"]);
    expect(afterRead.steps.find((s) => s.id === "pris")?.detail).toBe("Saknas för Pokémon 151.");
    expect(afterRead.next?.id).toBe("pris");

    await asUser(f.owner, (tx) =>
      tx.execute(
        sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
            values (${f.orgId}::uuid, ${titleId}::uuid, 4000, '2026-01-01')`,
      ),
    );
    const afterPrice = await load();
    expect(open(afterPrice)).toEqual(["kostnad"]);
    expect(afterPrice.headline).toBe("BL-002: 6 av 7 klart. Nästa: lägg in vad automaten kostade.");
    expect(afterPrice.next?.href).toBe(
      `/automater/enhetsekonomi?automat=${newMachine}&ny=1#investeringar`,
    );

    await asUser(f.owner, (tx) =>
      tx.execute(
        sql`insert into public.machine_investments
              (organization_id, machine_id, kind, amount_ore, invested_on)
            values (${f.orgId}::uuid, ${newMachine}::uuid, 'purchase', 4500000, '2026-10-20')`,
      ),
    );
    const done = await load();
    expect(done.complete).toBe(true);
    expect(done.left).toBeNull();
  });

  it("ett inköpspris som börjar gälla senare räknas inte som inlagt", async () => {
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.purchase_prices set valid_from = current_date + 30
            where organization_id = ${f.orgId}::uuid and title_id = ${titleId}::uuid`,
      ),
    );
    const r = byCode(await loadMachineReadinessFor(owner.user, f.orgId), "BL-002");
    expect(open(r)).toEqual(["pris"]);
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.purchase_prices set valid_from = '2026-01-01'
            where organization_id = ${f.orgId}::uuid and title_id = ${titleId}::uuid`,
      ),
    );
  });

  it("läsaren ser listan, påfyllaren och utomstående får en tom lista", async () => {
    expect((await loadMachineReadinessFor(session(reader), f.orgId)).length).toBe(2);
    expect(await loadMachineReadinessFor(session(refiller), f.orgId)).toEqual([]);
    const stranger = await createUser(`annan-${uniqueSuffix()}@test.binderlab.se`);
    await createOrg(stranger, `Annan ${uniqueSuffix()}`);
    expect(await loadMachineReadinessFor(session(stranger), f.orgId)).toEqual([]);
    expect(await loadMachineReadinessFor(owner.user, "inte-ett-id")).toEqual([]);
  });

  it("en avvecklad automat är inte med", async () => {
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.machines set active_to = '2026-01-31' where id = ${firstMachine}::uuid`,
      ),
    );
    const list = await loadMachineReadinessFor(owner.user, f.orgId);
    expect(list.map((r) => r.code)).toEqual(["BL-002"]);
  });
});
