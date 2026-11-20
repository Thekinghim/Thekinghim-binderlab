/**
 * Flera egna lager (Hemma + Kontoret) mot testdatabasen och låtsas-Awish:
 *
 * - nya organisationers lager heter Hemma; Kontoret skapas, byter namn och tas bort
 *   (bara när det är tomt, med Ångra); det sista lagret kan inte tas bort,
 * - antal och inköp i valt lager; flytt mellan lager ändrar inte summan, Ångra en gång,
 * - påfyllning från valt lager (Lager och Fyll på-kön) drar bara därifrån; utan val
 *   automatens "Fylls på från", annars standardlagret,
 * - Awish-uttaget dras ur automatens "Fylls på från" och syns som "från Kontoret"; en
 *   påfyllning i appen från ett annat lager lägger tillbaka Awish-uttaget (ingen dubbel
 *   dragning),
 * - roller och RLS: påfyllare och läsare kan inte ändra lagren eller flytta, en annan
 *   organisation når varken lagren eller saldot.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import { createAwishClient } from "../../src/server/awish/grpc-client";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import { syncAwishSource } from "../../src/server/awish/sync";
import { startFakeAwish, type FakeAwish } from "../../src/server/awish/testing/fake-server";
import type { Viewer } from "../../src/server/data/core/loaders";
import { syncRefillsFor } from "../../src/server/data/field-refills";
import { LagerError, registerRefillFor } from "../../src/app/(app)/lager/_lib/register";
import { loadFillDataFor } from "../../src/app/fyll-pa/_lib/data";
import { loadVartLagerFor } from "../../src/app/(app)/vart-lager/_lib/data";
import {
  archivePlaceFor,
  createPlaceFor,
  moveStockFor,
  registerReceiptFor,
  renamePlaceFor,
  setHomeCountFor,
  setRefillSourceFor,
  undoMoveFor,
} from "../../src/app/(app)/vart-lager/_lib/register";

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

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fake: FakeAwish;
const connect = (creds: { appId: string; appSecret: string; appKey: string }) =>
  createAwishClient(creds, { address: fake.address, tls: false, sleep: async () => {} });

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [{ id: "2", name: "Sega gubben", machine_no: "163271xx" }],
    orders: [],
    products: { "2": [{ channel: "A1", good: "Surging Sparks", current: 3, capacity: 12 }] },
  });
});
afterAll(async () => {
  await fake.stop();
});

const expectLagerError = async (p: Promise<unknown>, message: RegExp) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LagerError);
  expect((error as Error).message).toMatch(message);
};

describe("Flera lager: Hemma och Kontoret", () => {
  let owner: TestUser;
  let refiller: TestUser;
  let reader: TestUser;
  let orgId: string;
  let machine: string;
  let titleId: string;
  let hemma: string;
  let kontoret: string;
  let sourceId: string;

  const level = async (location: string, title = titleId) =>
    (
      await rows<{ q: number }>(
        db(),
        sql`select quantity as q from public.stock_levels
            where location_id = ${location}::uuid and title_id = ${title}::uuid`,
      )
    )[0]?.q ?? 0;
  const ownTotal = async () =>
    (
      await one<{ q: number }>(
        db(),
        sql`select coalesce(sum(quantity), 0)::int as q from public.warehouse_stock
            where organization_id = ${orgId}::uuid and title_id = ${titleId}::uuid`,
      )
    ).q;
  const ov = () => viewerFor(owner, orgId);
  const run = () =>
    syncAwishSource(
      { db: db(), connect, now: () => new Date() },
      { dataSourceId: sourceId, trigger: "manual" },
    );

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    refiller = await createMember(orgId, "refiller");
    reader = await createMember(orgId, "viewer");
    const [m] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: "BL-001",
          name: "Automat 1",
          activeFrom: "2026-10-01",
        })
        .returning(),
    );
    machine = m!.id;
    await asUser(owner, async (tx) => {
      const [store] = await tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Sega gubben" })
        .returning();
      await tx.insert(s.machinePlacements).values({
        organizationId: orgId,
        machineId: machine,
        storeId: store!.id,
        validFrom: "2026-10-01",
      });
    });
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await ov(), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    }));
    const first = await run();
    expect(first.ok, first.message ?? "").toBe(true);
    await db().execute(
      sql`update public.source_machines set machine_id = ${machine}::uuid
          where data_source_id = ${sourceId}::uuid and external_id = '2'`,
    );
    // Automatens första läsning (inget uttag) skapar titeln.
    expect((await run()).ok).toBe(true);
    titleId = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.titles where organization_id = ${orgId}::uuid and name = 'Surging Sparks'`,
      )
    ).id;
  });

  it("organisationens första lager heter Hemma och är standard", async () => {
    const list = await rows<{ id: string; name: string; is_central: boolean }>(
      db(),
      sql`select id, name, is_central from public.stock_locations
          where organization_id = ${orgId}::uuid and kind = 'warehouse'`,
    );
    expect(list).toEqual([{ id: expect.any(String), name: "Hemma", is_central: true }]);
    hemma = list[0]!.id;
  });

  it("ägaren skapar Kontoret; samma namn igen nekas, påfyllare och läsare får inte", async () => {
    const created = await createPlaceFor(await ov(), { name: "  Kontoret " });
    expect(created.name).toBe("Kontoret");
    kontoret = created.id;
    await expectLagerError(createPlaceFor(await ov(), { name: "kontoret" }), /redan ett lager/);
    for (const u of [refiller, reader]) {
      const out = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`select public.create_warehouse(${orgId}::uuid, 'Förrådet')`),
        ),
      );
      expect(out).toMatchObject({ ok: false, code: "42501" });
    }
    const view = await loadVartLagerFor(await ov());
    expect(view.places.map((p) => p.name)).toEqual(["Hemma", "Kontoret"]);
  });

  it("antal och inköp i valt lager; summan är alla lager", async () => {
    await setHomeCountFor(await ov(), { titleId, counted: 40, warehouseId: hemma });
    const counted = await setHomeCountFor(await ov(), {
      titleId,
      counted: 6,
      warehouseId: kontoret,
    });
    expect(counted).toMatchObject({ onHand: 6, placeName: "Kontoret" });
    const bought = await registerReceiptFor(await ov(), {
      titleId,
      quantity: 4,
      warehouseId: kontoret,
    });
    expect(bought).toMatchObject({ previous: 6, onHand: 10, placeName: "Kontoret" });
    expect(await level(hemma)).toBe(40);
    expect(await ownTotal()).toBe(50);
    const view = await loadVartLagerFor(await ov());
    const row = view.rows.find((r) => r.titleId === titleId)!;
    expect(row).toMatchObject({ home: 50, byPlace: { [hemma]: 40, [kontoret]: 10 } });
    expect(row.latest?.text).toBe("+4 till Kontoret, inköp");
    expect(view.totals.byPlace).toEqual({ [hemma]: 40, [kontoret]: 10 });
  });

  it("flytt: ut ur det ena, in i det andra, summan oförändrad; Ångra en gång", async () => {
    const moved = await moveStockFor(await ov(), {
      titleId,
      from: hemma,
      to: kontoret,
      quantity: 5,
    });
    expect(moved).toMatchObject({
      fromName: "Hemma",
      toName: "Kontoret",
      fromOnHand: 35,
      toOnHand: 15,
    });
    expect(await ownTotal()).toBe(50);
    const events = await rows<{ kind: string; quantity: number; location_id: string }>(
      db(),
      sql`select kind::text, quantity, location_id::text from public.stock_events
          where transfer_group_id = ${moved.transferId}::uuid order by kind`,
    );
    expect(events).toEqual([
      { kind: "transfer_in", quantity: 5, location_id: kontoret },
      { kind: "transfer_out", quantity: -5, location_id: hemma },
    ]);
    const view = await loadVartLagerFor(await ov());
    const row = view.rows.find((r) => r.titleId === titleId)!;
    expect(row.latestByPlace[kontoret]?.text).toBe("+5 flytt från Hemma");
    expect(row.latestByPlace[hemma]?.text).toBe("−5 flytt till Kontoret");

    const undone = await undoMoveFor(await ov(), { transferId: moved.transferId });
    expect(undone).toMatchObject({ fromName: "Kontoret", toName: "Hemma", toOnHand: 40 });
    expect(await level(kontoret)).toBe(10);
    expect(await ownTotal()).toBe(50);
    await expectLagerError(
      undoMoveFor(await ov(), { transferId: moved.transferId }),
      /redan ångrad/,
    );
  });

  it("flytt nekas: fler än det finns, samma lager, påfyllare och läsare", async () => {
    await expectLagerError(
      moveStockFor(await ov(), { titleId, from: kontoret, to: hemma, quantity: 11 }),
      /Kontoret har bara 10 pack/,
    );
    const same = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.transfer_stock(${orgId}::uuid, ${hemma}::uuid, ${hemma}::uuid, ${titleId}::uuid, 1)`,
        ),
      ),
    );
    expect(same).toMatchObject({ ok: false, code: "22023" });
    for (const u of [refiller, reader]) {
      const out = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`select public.transfer_stock(${orgId}::uuid, ${hemma}::uuid, ${kontoret}::uuid, ${titleId}::uuid, 1)`,
          ),
        ),
      );
      expect(out).toMatchObject({ ok: false, code: "42501" });
    }
    expect(await ownTotal()).toBe(50);
  });

  it("påfyllning från valt lager drar bara därifrån", async () => {
    const res = await registerRefillFor(await viewerFor(refiller, orgId), {
      machineId: machine,
      titleId,
      quantity: 3,
      fromWarehouse: true,
      fromLocationId: kontoret,
    });
    expect(res).toMatchObject({ warehouseOnHand: 7, placeName: "Kontoret" });
    expect(await level(kontoret)).toBe(7);
    expect(await level(hemma)).toBe(40);
    // För många från Kontoret: nekas med lagrets namn.
    await expectLagerError(
      registerRefillFor(await viewerFor(refiller, orgId), {
        machineId: machine,
        titleId,
        quantity: 8,
        fromWarehouse: true,
        fromLocationId: kontoret,
      }),
      /Kontoret har bara 7 pack av Surging Sparks/,
    );
  });

  it("Fyll på-kön: valt lager följer med; utan val dras automatens Fylls på från", async () => {
    const rv = await viewerFor(refiller, orgId);
    const at = new Date().toISOString();
    const first = await syncRefillsFor(rv, [
      {
        clientId: randomUUID(),
        machineId: machine,
        titleId,
        quantity: 2,
        fromWarehouse: true,
        fromLocationId: kontoret,
        occurredAt: at,
      },
    ]);
    expect(first.results[0]?.status).toBe("saved");
    expect(await level(kontoret)).toBe(5);
    const stored = await one<{ from_location_id: string | null }>(
      db(),
      sql`select from_location_id::text from public.field_submissions
          where organization_id = ${orgId}::uuid order by created_at desc limit 1`,
    );
    expect(stored.from_location_id).toBe(kontoret);

    // Påfyllaren får inte välja automatens lager.
    const denied = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.set_refill_source(${orgId}::uuid, ${machine}::uuid, ${kontoret}::uuid)`,
        ),
      ),
    );
    expect(denied).toMatchObject({ ok: false, code: "42501" });
    expect(await setRefillSourceFor(await ov(), { machineId: machine, placeId: kontoret })).toEqual(
      { placeId: kontoret, name: "Kontoret" },
    );
    const data = await loadFillDataFor(rv);
    expect(data.sources.machineSource[machine]).toBe(kontoret);
    expect(data.sources.stock[kontoret]?.[titleId]).toBe(5);

    const second = await syncRefillsFor(rv, [
      {
        clientId: randomUUID(),
        machineId: machine,
        titleId,
        quantity: 1,
        fromWarehouse: true,
        occurredAt: new Date().toISOString(),
      },
    ]);
    expect(second.results[0]?.status).toBe("saved");
    expect(await level(kontoret)).toBe(4);
    expect(await level(hemma)).toBe(40);
  });

  it("Awish-uttaget dras ur automatens Fylls på från och visas som från Kontoret", async () => {
    // Saldot i automaten nu: 3 (Awish) + 3 + 2 + 1 påfyllda = 9. Awish visar 11: +2.
    fake.state.products["2"]![0]!.current = 11;
    const r = await run();
    expect(r.stock).toMatchObject({ warehouseOut: 2 });
    expect(await level(kontoret)).toBe(2);
    expect(await level(hemma)).toBe(40);
    const out = await one<{ note: string; source: string }>(
      db(),
      sql`select note, source from public.stock_events
          where location_id = ${kontoret}::uuid and source = 'awish' order by seq desc limit 1`,
    );
    expect(out).toEqual({ note: "Awish-påfyllning BL-001 Sega gubben", source: "awish" });
    const view = await loadVartLagerFor(await ov());
    const row = view.rows.find((x) => x.titleId === titleId)!;
    expect(row.latest).toMatchObject({
      text: "−2 från Kontoret, påfyllning Sega gubben",
      automatic: true,
    });
  });

  it("samma påfyllning registrerad i appen från Hemma: Awish-uttaget läggs tillbaka i Kontoret", async () => {
    await registerRefillFor(await ov(), {
      machineId: machine,
      titleId,
      quantity: 2,
      fromWarehouse: true,
      fromLocationId: hemma,
    });
    // Kontoret får tillbaka 2, Hemma −2: packen drogs bara en gång.
    expect(await level(kontoret)).toBe(4);
    expect(await level(hemma)).toBe(38);
    expect(await ownTotal()).toBe(42);
  });

  it("ett lager med pack kan inte tas bort; tomt lager kan, med Ångra", async () => {
    await expectLagerError(
      archivePlaceFor(await ov(), { id: kontoret, archived: true }),
      /Kontoret är inte tomt/,
    );
    // Direkt uppdatering förbi RPC:n stoppas också.
    const direct = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.stock_locations set archived_at = now()
              where organization_id = ${orgId}::uuid and id = ${kontoret}::uuid`,
        ),
      ),
    );
    expect(direct).toMatchObject({ ok: false, code: "22023" });

    await moveStockFor(await ov(), { titleId, from: kontoret, to: hemma, quantity: 4 });
    expect(await ownTotal()).toBe(42);
    await archivePlaceFor(await ov(), { id: kontoret, archived: true });
    // Inga nya händelser på ett borttaget lager.
    await expectLagerError(
      setHomeCountFor(await ov(), { titleId, counted: 1, warehouseId: kontoret }),
      /Lagret finns inte/,
    );
    const blocked = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.stockEvents).values({
          organizationId: orgId,
          locationId: kontoret,
          titleId,
          kind: "receipt",
          quantity: 1,
          performedBy: owner.id,
        }),
      ),
    );
    expect(blocked).toMatchObject({ ok: false, code: "22023" });
    // Automaten fylldes från Kontoret: nu standardlagret (Hemma).
    const data = await loadFillDataFor(await viewerFor(refiller, orgId));
    expect(data.sources.places.map((p) => p.name)).toEqual(["Hemma"]);
    expect(data.sources.machineSource[machine]).toBeUndefined();
    await registerRefillFor(await ov(), {
      machineId: machine,
      titleId,
      quantity: 1,
      fromWarehouse: true,
    });
    expect(await level(hemma)).toBe(41);

    // Ångra: tillbaka, och automaten fylls från Kontoret igen.
    await archivePlaceFor(await ov(), { id: kontoret, archived: false });
    const back = await loadFillDataFor(await viewerFor(refiller, orgId));
    expect(back.sources.machineSource[machine]).toBe(kontoret);
  });

  it("det sista lagret kan inte tas bort; standardlagret flyttar när det tas bort", async () => {
    const tmp = await createPlaceFor(await ov(), { name: "Förrådet" });
    await renamePlaceFor(await ov(), { id: tmp.id, name: "Garaget" });
    await moveStockFor(await ov(), { titleId, from: hemma, to: kontoret, quantity: 41 });
    await archivePlaceFor(await ov(), { id: hemma, archived: true });
    const central = await one<{ name: string }>(
      db(),
      sql`select name from public.stock_locations
          where organization_id = ${orgId}::uuid and is_central`,
    );
    expect(central.name).toBe("Kontoret");
    await archivePlaceFor(await ov(), { id: tmp.id, archived: true });
    await expectLagerError(
      archivePlaceFor(await ov(), { id: kontoret, archived: true }),
      /sista lagret/,
    );
    expect(await ownTotal()).toBe(41);
  });

  it("en annan organisation ser inte lagren och kan inte flytta eller fylla från dem", async () => {
    const other = await createUser();
    const otherOrg = await createOrg(other);
    const seen = await asUser(other, (tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from public.stock_locations where id = ${kontoret}::uuid`,
      ),
    );
    expect(seen[0]!.n).toBe(0);
    const levels = await asUser(other, (tx) =>
      rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from public.warehouse_stock where organization_id = ${orgId}::uuid`,
      ),
    );
    expect(levels[0]!.n).toBe(0);
    for (const q of [
      sql`select public.transfer_stock(${orgId}::uuid, ${kontoret}::uuid, ${hemma}::uuid, ${titleId}::uuid, 1)`,
      sql`select public.archive_warehouse(${orgId}::uuid, ${kontoret}::uuid)`,
      sql`select public.rename_warehouse(${orgId}::uuid, ${kontoret}::uuid, 'Mitt')`,
    ]) {
      const out = await asUser(other, (tx) => attempt(tx, (sp) => sp.execute(q)));
      expect(out).toMatchObject({ ok: false, code: "42501" });
    }
    // I den egna organisationen: främmande lager-id finns inte.
    const otherTitle = await asUser(other, (tx) =>
      tx.insert(s.titles).values({ organizationId: otherOrg, name: "Egen titel" }).returning(),
    );
    const own = await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where organization_id = ${otherOrg}::uuid and is_central`,
    );
    const foreign = await asUser(other, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.transfer_stock(${otherOrg}::uuid, ${kontoret}::uuid, ${own.id}::uuid, ${otherTitle[0]!.id}::uuid, 1)`,
        ),
      ),
    );
    expect(foreign).toMatchObject({ ok: false, code: "22023" });
    expect(await ownTotal()).toBe(41);
  });
});
