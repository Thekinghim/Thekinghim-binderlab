/**
 * Butiksägare (20261219000000_butiksagare.sql och src/app/(app)/butiker/_lib/owner-service.ts)
 * mot testdatabasen: ny ägare, ändring, butikens ägare, arkivering, dubblett av
 * organisationsnummer, formatkontrollerna i databasen, raderingsspärren, ändringsloggen
 * och RLS för varje roll (ägare, admin, läsare, påfyllare, butiksanvändare) och för en
 * annan organisation. Alla uppgifter är påhittade.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createOwnerFor,
  loadOwnersFor,
  setOwnerArchivedFor,
  setStoreOwnerFor,
  updateOwnerFor,
} from "../../src/app/(app)/butiker/_lib/owner-service";
import { createStoreFor, type Viewer } from "../../src/app/(app)/butiker/_lib/service";
import { listOrganizationsFor } from "../../src/server/access";

import {
  asPostgres,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";
import { inviteStoreUser } from "./portal-fixture";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

/** Påhittat bolag (organisationsnumret har rätt kontrollsiffra). */
const BOLAG = {
  legalName: "Godisbolaget Väst AB",
  orgNumber: "5599001236",
  vatNumber: "se559900123601",
  fTax: true,
  streetAddress: "Testgatan 1",
  postalCode: "44130",
  city: "Testby",
  contactName: "Kim Test",
  email: "kim@example.se",
  phone: "070-000 00 00",
  invoiceEmail: "faktura@example.se",
  bankgiro: "123-4566",
  note: "Påhittad ägare för test.",
};

let orgId: string;
let ownerUser: TestUser;
let owner: Viewer;
let admin: Viewer;
let reader: Viewer;
let refiller: Viewer;
let adminUser: TestUser;
let readerUser: TestUser;
let refillerUser: TestUser;
let outsiderUser: TestUser;
let outsider: Viewer;
let storeA: string;
let storeB: string;
let storeC: string;

beforeAll(async () => {
  ownerUser = await createUser(`ag-owner-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(ownerUser, `Ägare ${uniqueSuffix()}`);
  owner = await viewerFor(ownerUser, orgId);
  adminUser = await createMember(orgId, "admin");
  admin = await viewerFor(adminUser, orgId);
  readerUser = await createMember(orgId, "viewer");
  reader = await viewerFor(readerUser, orgId);
  refillerUser = await createMember(orgId, "refiller");
  refiller = await viewerFor(refillerUser, orgId);
  outsiderUser = await createUser(`ag-other-${uniqueSuffix()}@test.binderlab.se`);
  outsider = await viewerFor(
    outsiderUser,
    await createOrg(outsiderUser, `Annan ${uniqueSuffix()}`),
  );
  const mk = async (name: string) => {
    const r = await createStoreFor(owner, { name, city: "Testby" });
    if (!r.ok) throw new Error(r.error);
    return r.data!.id;
  };
  storeA = await mk("Butik Alfa");
  storeB = await mk("Butik Beta");
  storeC = await mk("Butik Gamma");
});

async function newOwner(extra: Record<string, unknown> = {}): Promise<string> {
  const orgNumber = (extra.orgNumber as string | undefined) ?? BOLAG.orgNumber;
  const r = await createOwnerFor(owner, { ...BOLAG, ...extra, orgNumber });
  if (!r.ok) throw new Error(r.error);
  return r.data!.id;
}

describe("ny ägare och ändring", () => {
  it("sparar uppgifterna normaliserade och kopplar butiker", async () => {
    const id = await newOwner();
    const row = await one<Record<string, unknown>>(
      db(),
      sql`select legal_name, org_number, vat_number, f_tax, postal_code, bankgiro,
                 invoice_email::text as invoice_email
          from public.store_owners where id = ${id}`,
    );
    expect(row).toEqual({
      legal_name: "Godisbolaget Väst AB",
      org_number: "559900-1236",
      vat_number: "SE559900123601",
      f_tax: true,
      postal_code: "441 30",
      bankgiro: "123-4566",
      invoice_email: "faktura@example.se",
    });

    for (const storeId of [storeA, storeB]) {
      expect(await setStoreOwnerFor(owner, { storeId, ownerId: id })).toEqual({
        ok: true,
        data: undefined,
      });
    }
    const [o] = (await loadOwnersFor(reader)).filter((x) => x.id === id);
    expect(o?.stores.map((st) => st.name)).toEqual(["Butik Alfa", "Butik Beta"]);

    // Samma organisationsnummer igen: dubblett.
    const dup = await createOwnerFor(owner, { ...BOLAG, legalName: "Annat namn" });
    expect(dup).toEqual({
      ok: false,
      error: "Det finns redan en butiksägare med det organisationsnumret.",
    });

    // Admin ändrar; fel kontrollsiffra nekas.
    expect(
      await updateOwnerFor(admin, { ...BOLAG, ownerId: id, orgNumber: "559900-1237" }),
    ).toEqual({ ok: false, error: "Organisationsnumret stämmer inte. Kontrollera siffrorna." });
    expect(
      await updateOwnerFor(admin, {
        ...BOLAG,
        ownerId: id,
        legalName: "Godisbolaget Väst AB (nytt)",
      }),
    ).toEqual({ ok: true, data: undefined });

    // Arkivering nekas så länge aktiva butiker har ägaren.
    const blocked = await setOwnerArchivedFor(owner, { ownerId: id, archived: true });
    expect(blocked.ok).toBe(false);
    expect(blocked.ok ? "" : blocked.error).toMatch(/Butik Alfa, Butik Beta har den här ägaren/);
    await setStoreOwnerFor(owner, { storeId: storeA, ownerId: "" });
    await setStoreOwnerFor(owner, { storeId: storeB, ownerId: null });
    expect(await setOwnerArchivedFor(owner, { ownerId: id, archived: true })).toEqual({
      ok: true,
      data: undefined,
    });
    // En arkiverad ägare väljs inte och ändras inte; dess nummer är ledigt igen.
    expect(await setStoreOwnerFor(owner, { storeId: storeA, ownerId: id })).toEqual({
      ok: false,
      error: "Butiksägaren är arkiverad. Återställ den först.",
    });
    expect((await updateOwnerFor(owner, { ...BOLAG, ownerId: id })).ok).toBe(false);
    const again = await newOwner();
    expect(again).not.toBe(id);
    await setOwnerArchivedFor(owner, { ownerId: again, archived: true });
  });

  it("Ny ägare på butikens sida: ägaren skapas och kopplas i samma transaktion", async () => {
    const r = await createOwnerFor(owner, {
      legalName: "Eget Bolag AB",
      orgNumber: "802400-0013",
      storeId: storeC,
    });
    expect(r.ok).toBe(true);
    const st = await one<{ owner_id: string }>(
      db(),
      sql`select owner_id from public.stores where id = ${storeC}`,
    );
    expect(st.owner_id).toBe(r.ok ? r.data!.id : "");

    // Okänd butik: ingen ny ägare heller.
    const before = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.store_owners where organization_id = ${orgId}`,
    );
    const bad = await createOwnerFor(owner, {
      legalName: "Ska inte finnas AB",
      orgNumber: "991234-5676",
      storeId: "00000000-0000-4000-8000-000000000000",
    });
    expect(bad).toEqual({ ok: false, error: "Butiken finns inte." });
    const after = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.store_owners where organization_id = ${orgId}`,
    );
    expect(after.n).toBe(before.n);
  });

  it("läsaren, påfyllaren och en annan organisation får inte ändra", async () => {
    const id = await newOwner({ orgNumber: "123456-7897", legalName: "Behörighet AB" });
    for (const v of [reader, refiller]) {
      expect(await createOwnerFor(v, { ...BOLAG, orgNumber: "556000-0001" })).toEqual({
        ok: false,
        error: "Bara ägare och admin kan ändra butiksägare.",
      });
      expect((await setStoreOwnerFor(v, { storeId: storeA, ownerId: id })).ok).toBe(false);
    }
    // Annan organisation: ägaren och butiken finns inte för den.
    expect(await setStoreOwnerFor(outsider, { storeId: storeA, ownerId: id })).toEqual({
      ok: false,
      error: "Butiksägaren finns inte.",
    });
    expect(await updateOwnerFor(outsider, { ...BOLAG, ownerId: id })).toEqual({
      ok: false,
      error: "Butiksägaren finns inte.",
    });
    expect((await loadOwnersFor(outsider)).length).toBe(0);
    await expect(loadOwnersFor(refiller)).rejects.toThrow();
  });
});

describe("databasen", () => {
  it("formatkontroller, sammansatt FK och ingen radering", async () => {
    const id = await newOwner({ orgNumber: "198001010118", legalName: "Enskild Firma Test" });
    const outcome = (q: ReturnType<typeof sql>) =>
      asUser(ownerUser, (tx) => attempt(tx, (sp) => sp.execute(q)));
    for (const q of [
      sql`insert into public.store_owners (organization_id, legal_name, org_number)
          values (${orgId}, 'X', '5599001236')`,
      sql`update public.store_owners set vat_number = 'SE559900123602' where id = ${id}`,
      sql`update public.store_owners set postal_code = '44130' where id = ${id}`,
      sql`update public.store_owners set bankgiro = '1234566' where id = ${id}`,
    ]) {
      expect((await outcome(q)).code).toBe("23514");
    }
    // Klienten har ingen rätt att radera; inte heller systemet (triggern: arkivera i stället).
    expect((await outcome(sql`delete from public.store_owners where id = ${id}`)).code).toBe(
      "42501",
    );
    const asSystem = await asPostgres((tx) =>
      attempt(tx, (sp) => sp.execute(sql`delete from public.store_owners where id = ${id}`)),
    );
    expect(asSystem.code).toBe("BL003");

    // En butik i en annan organisation kan inte peka på ägaren.
    const foreignStore = await asUser(outsiderUser, (tx) =>
      one<{ id: string }>(
        tx,
        sql`insert into public.stores (organization_id, name)
            values (${outsider.organization.id}, 'Främmande') returning id`,
      ),
    );
    const cross = await asUser(outsiderUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.stores set owner_id = ${id} where id = ${foreignStore.id}`),
      ),
    );
    expect(cross.code).toBe("23503");
  });

  it("ändringarna loggas i audit_log", async () => {
    const id = await newOwner({ orgNumber: "556677-8899", legalName: "Logg AB" });
    await updateOwnerFor(owner, {
      ...BOLAG,
      ownerId: id,
      orgNumber: "556677-8899",
      city: "Ny ort",
    });
    await setStoreOwnerFor(owner, { storeId: storeB, ownerId: id });
    const logged = await rows<{ table_name: string; action: string }>(
      db(),
      sql`select table_name, action::text as action from public.audit_log
          where organization_id = ${orgId} and (row_id = ${id} or row_id = ${storeB})
          order by occurred_at, id`,
    );
    expect(logged.filter((l) => l.table_name === "store_owners").map((l) => l.action)).toEqual([
      "insert",
      "update",
    ]);
    expect(logged.some((l) => l.table_name === "stores" && l.action === "update")).toBe(true);
    await setStoreOwnerFor(owner, { storeId: storeB, ownerId: null });
  });
});

describe("RLS", () => {
  it("ägare, admin och läsare ser ägarna; påfyllare, butiksanvändare och andra inget", async () => {
    await newOwner({ orgNumber: "991234-5676", legalName: "Synlig AB" });
    const count = (u: TestUser) =>
      asUser(u, (tx) =>
        one<{ n: number }>(
          tx,
          sql`select count(*)::int as n from public.store_owners where organization_id = ${orgId}`,
        ),
      );
    expect((await count(ownerUser)).n).toBeGreaterThan(0);
    expect((await count(adminUser)).n).toBeGreaterThan(0);
    expect((await count(readerUser)).n).toBeGreaterThan(0);
    expect((await count(refillerUser)).n).toBe(0);
    expect((await count(outsiderUser)).n).toBe(0);
    const storeUser = await inviteStoreUser(ownerUser, orgId, storeA);
    expect((await count(storeUser)).n).toBe(0);
  });

  it("påfyllaren ser butikerna men inte deras ägare eller avtalsform", async () => {
    const o = await newOwner({ orgNumber: "991234-5684", legalName: "Dold Ägare AB" });
    await db().execute(
      sql`update public.stores set owner_id = ${o}, agreement_form = 'oral'
          where id in (${storeA}, ${storeB})`,
    );
    // Butikens namn och adress läser påfyllaren som förut.
    const names = await asUser(refillerUser, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id, name, address from public.stores where organization_id = ${orgId}`,
      ),
    );
    expect(names.map((r) => r.id)).toEqual(expect.arrayContaining([storeA, storeB]));
    // Kolumnerna själva nekas, också i hela raden.
    for (const q of [
      sql`select owner_id from public.stores where organization_id = ${orgId}`,
      sql`select agreement_form from public.stores where organization_id = ${orgId}`,
      sql`select to_jsonb(st) from public.stores st where st.organization_id = ${orgId}`,
      sql`select id from public.stores where owner_id = ${o}`,
    ]) {
      const r = await asUser(refillerUser, (tx) => attempt(tx, (sp) => sp.execute(q)));
      expect(r.ok).toBe(false);
    }
    // store_terms ger inget till påfyllaren, butiksanvändaren eller en annan organisation.
    const terms = (u: TestUser) =>
      asUser(u, (tx) =>
        rows<{ store_id: string; owner_id: string | null; agreement_form: string | null }>(
          tx,
          sql`select * from public.store_terms(${orgId}::uuid) where store_id = ${storeA}`,
        ),
      );
    expect(await terms(refillerUser)).toEqual([]);
    expect(await terms(outsiderUser)).toEqual([]);
    expect(await terms(await inviteStoreUser(ownerUser, orgId, storeB))).toEqual([]);
    for (const u of [ownerUser, adminUser, readerUser]) {
      expect(await terms(u)).toEqual([{ store_id: storeA, owner_id: o, agreement_form: "oral" }]);
    }
    // Ägarens kort på Butiksägare visar butikerna (läst genom store_terms).
    expect((await loadOwnersFor(owner)).find((x) => x.id === o)?.stores.length).toBe(2);
  });

  it("läsare, påfyllare och andra kan inte skriva direkt", async () => {
    const target = await one<{ id: string }>(
      db(),
      sql`select id from public.store_owners where organization_id = ${orgId} limit 1`,
    );
    for (const u of [readerUser, refillerUser, outsiderUser]) {
      const ins = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`insert into public.store_owners (organization_id, legal_name, org_number)
                         values (${orgId}, 'Intrång AB', '556000-0001')`),
        ),
      );
      expect(ins.ok).toBe(false);
      const upd = await asUser(u, (tx) =>
        rows(
          tx,
          sql`update public.store_owners set note = 'intrång' where id = ${target.id} returning id`,
        ),
      );
      expect(upd.length).toBe(0);
    }
  });
});
