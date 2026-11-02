/**
 * Butiker (src/app/(app)/butiker/_lib/service.ts) mot testdatabasen: ny butik och
 * redigering, avtal (nytt avtal avslutar det gällande, inga överlapp, rättning, stängd
 * månad), rapportmottagare (lägg till, dubblett, pausa, ta bort), arkivering, behörighet
 * (läsaren och påfyllaren får inte ändra, påfyllaren får inga avtal eller mottagare,
 * annan organisation ser inget) och att ändringarna loggas i audit_log.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createAgreementFor,
  createStoreFor,
  createStoreRecipientFor,
  deleteStoreRecipientFor,
  loadAgreementsFor,
  loadRecipientsFor,
  loadStoresFor,
  setStoreArchivedFor,
  updateAgreementFor,
  updateStoreFor,
  updateStoreRecipientFor,
  type Viewer,
} from "../../src/app/(app)/butiker/_lib/service";
import * as s from "../../src/db/schema";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const TODAY = "2026-11-02";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let orgId: string;
let ownerUser: TestUser;
let owner: Viewer;
let reader: Viewer;
let refiller: Viewer;
let outsider: Viewer;

beforeAll(async () => {
  ownerUser = await createUser(`bu-owner-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(ownerUser, `Butiker ${uniqueSuffix()}`);
  owner = await viewerFor(ownerUser, orgId);
  reader = await viewerFor(await createMember(orgId, "viewer"), orgId);
  refiller = await viewerFor(await createMember(orgId, "refiller"), orgId);
  const otherOwner = await createUser(`bu-other-${uniqueSuffix()}@test.binderlab.se`);
  const otherOrg = await createOrg(otherOwner, `Annan ${uniqueSuffix()}`);
  outsider = await viewerFor(otherOwner, otherOrg);
  // Oktober 2025 stängd (för kontrollen av stängda månader).
  await asUser(ownerUser, (tx) =>
    tx.execute(sql`select public.close_period(${orgId}, '2025-10-01'::date)`),
  );
});

async function newStore(name = "ICA Testbutik"): Promise<string> {
  const r = await createStoreFor(owner, { name, city: "Lund" });
  if (!r.ok) throw new Error(r.error);
  return r.data!.id;
}

async function agreementsOf(storeId: string) {
  return rows<{
    valid_from: string;
    valid_to: string | null;
    commission_bp: number | null;
    monthly_rent_ore: string | null;
  }>(
    db(),
    sql`select valid_from::text, valid_to::text, commission_bp, monthly_rent_ore
        from public.store_agreements where store_id = ${storeId} order by valid_from`,
  );
}

async function auditCount(table: string, rowId: string): Promise<number> {
  const [r] = await rows<{ n: string }>(
    db(),
    sql`select count(*)::text as n from public.audit_log where table_name = ${table} and row_id = ${rowId}`,
  );
  return Number(r?.n ?? 0);
}

describe("butiker", () => {
  it("ägaren lägger till och redigerar en butik; det loggas", async () => {
    const id = await newStore("Kiosken");
    const r = await updateStoreFor(owner, {
      storeId: id,
      name: "Kiosken Stationen",
      address: "Stationsvägen 1",
      city: "Lund",
      contactName: "Anna",
      email: "anna@example.se",
      phone: "046-12 34 56",
      isExample: true,
    });
    expect(r).toEqual({ ok: true, data: undefined });
    const store = (await loadStoresFor(owner)).find((x) => x.id === id)!;
    expect(store).toMatchObject({
      name: "Kiosken Stationen",
      email: "anna@example.se",
      isExample: true,
      archived: false,
    });
    expect(await auditCount("stores", id)).toBe(2);
  });

  it("ogiltiga uppgifter ger svenska fel", async () => {
    expect(await createStoreFor(owner, { name: "" })).toEqual({
      ok: false,
      error: "Ange butikens namn.",
    });
    expect((await createStoreFor(owner, { name: "X", email: "nej" })).ok).toBe(false);
  });

  it("läsaren och påfyllaren får inte ändra; påfyllaren får inga avtal", async () => {
    const id = await newStore();
    for (const v of [reader, refiller]) {
      expect(await createStoreFor(v, { name: "Smyg" })).toEqual({
        ok: false,
        error: "Bara ägare och admin kan ändra butiker.",
      });
      expect(
        (await createAgreementFor(v, { storeId: id, validFrom: TODAY, commission: "10" }, TODAY))
          .ok,
      ).toBe(false);
    }
    await expect(loadAgreementsFor(refiller)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(loadRecipientsFor(refiller, id)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(loadStoresFor(refiller)).rejects.toBeInstanceOf(AuthorizationError);
    expect((await loadStoresFor(reader)).some((x) => x.id === id)).toBe(true);
  });

  it("en annan organisation ser och ändrar inget", async () => {
    const id = await newStore();
    expect((await loadStoresFor(outsider)).some((x) => x.id === id)).toBe(false);
    expect(
      await createAgreementFor(
        outsider,
        { storeId: id, validFrom: TODAY, commission: "10" },
        TODAY,
      ),
    ).toEqual({ ok: false, error: "Butiken finns inte." });
    expect(await updateStoreFor(outsider, { storeId: id, name: "Kapad" })).toEqual({
      ok: false,
      error: "Butiken finns inte.",
    });
  });
});

describe("avtal", () => {
  it("nytt avtal avslutar det gällande dagen före och historiken behålls", async () => {
    const id = await newStore();
    const a = await createAgreementFor(
      owner,
      { storeId: id, validFrom: "2026-10-01", commission: "12" },
      TODAY,
    );
    expect(a.ok).toBe(true);
    const b = await createAgreementFor(
      owner,
      { storeId: id, validFrom: "2026-11-15", commission: "10", rent: "750" },
      TODAY,
    );
    expect(b.ok && b.data?.closedId).toBe(a.ok ? a.data?.id : null);
    expect(await agreementsOf(id)).toEqual([
      {
        valid_from: "2026-10-01",
        valid_to: "2026-11-14",
        commission_bp: 1200,
        monthly_rent_ore: null,
      },
      { valid_from: "2026-11-15", valid_to: null, commission_bp: 1000, monthly_rent_ore: "75000" },
    ]);
    // Uppdateringen av det gamla och det nya avtalet loggas.
    expect(await auditCount("store_agreements", a.ok ? a.data!.id : "")).toBe(2);
  });

  it("inga överlapp: samma startdag och ett senare tillsvidareavtal stoppas", async () => {
    const id = await newStore();
    await createAgreementFor(owner, { storeId: id, validFrom: "2026-12-01", rent: "500" }, TODAY);
    const same = await createAgreementFor(
      owner,
      { storeId: id, validFrom: "2026-12-01", commission: "5" },
      TODAY,
    );
    expect(same).toEqual({
      ok: false,
      error: "Det finns redan ett avtal från 1\u00a0dec. Ändra det i stället.",
    });
    const before = await createAgreementFor(
      owner,
      { storeId: id, validFrom: "2026-11-01", commission: "5" },
      TODAY,
    );
    expect(before.ok).toBe(false);
    const bounded = await createAgreementFor(
      owner,
      { storeId: id, validFrom: "2026-11-01", validTo: "2026-11-30", commission: "5" },
      TODAY,
    );
    expect(bounded.ok).toBe(true);
    expect((await agreementsOf(id)).length).toBe(2);
  });

  it("minst provision eller hyra krävs", async () => {
    const id = await newStore();
    expect(await createAgreementFor(owner, { storeId: id, validFrom: TODAY }, TODAY)).toEqual({
      ok: false,
      error: "Ange provision, hyra eller båda.",
    });
  });

  it("rättning av villkor och sista dag, utan att krocka med nästa avtal", async () => {
    const id = await newStore();
    const a = await createAgreementFor(
      owner,
      { storeId: id, validFrom: "2026-10-01", commission: "12" },
      TODAY,
    );
    await createAgreementFor(owner, { storeId: id, validFrom: "2026-12-01", rent: "900" }, TODAY);
    const agreementId = a.ok ? a.data!.id : "";
    const clash = await updateAgreementFor(
      owner,
      { agreementId, validTo: "2026-12-05", commission: "12" },
      TODAY,
    );
    expect(clash.ok).toBe(false);
    const fixed = await updateAgreementFor(
      owner,
      { agreementId, validTo: "2026-11-30", commission: "12,5", rent: "100" },
      TODAY,
    );
    expect(fixed).toEqual({ ok: true, data: { storeId: id } });
    expect((await agreementsOf(id))[0]).toEqual({
      valid_from: "2026-10-01",
      valid_to: "2026-11-30",
      commission_bp: 1250,
      monthly_rent_ore: "10000",
    });
    expect(await updateAgreementFor(reader, { agreementId, commission: "1" }, TODAY)).toEqual({
      ok: false,
      error: "Bara ägare och admin kan ändra butiker.",
    });
  });

  it("ett nytt avtal i en stängd månad stoppas av databasen", async () => {
    const id = await newStore();
    const r = await createAgreementFor(
      owner,
      { storeId: id, validFrom: "2025-10-15", commission: "10" },
      TODAY,
    );
    expect(r.ok).toBe(false);
    expect(await agreementsOf(id)).toEqual([]);
  });
});

describe("rapportmottagare", () => {
  it("lägg till, dubblett, pausa, ta bort; loggas", async () => {
    const id = await newStore();
    const r = await createStoreRecipientFor(owner, {
      storeId: id,
      name: "Anna",
      email: "anna@example.se",
    });
    expect(r.ok).toBe(true);
    const rid = r.ok ? r.data!.id : "";
    expect(
      await createStoreRecipientFor(owner, { storeId: id, name: "Anna", email: "ANNA@example.se" }),
    ).toEqual({ ok: false, error: "ANNA@example.se tar redan emot butikens rapport." });
    expect(
      await updateStoreRecipientFor(owner, {
        recipientId: rid,
        name: "Anna A",
        email: "anna@example.se",
        active: false,
      }),
    ).toEqual({ ok: true, data: undefined });
    const list = await loadRecipientsFor(reader, id);
    expect(list).toEqual([
      { id: rid, name: "Anna A", email: "anna@example.se", active: false, lastSentAt: null },
    ]);
    expect(await deleteStoreRecipientFor(reader, { recipientId: rid })).toEqual({
      ok: false,
      error: "Bara ägare och admin kan ändra butiker.",
    });
    expect(await deleteStoreRecipientFor(owner, { recipientId: rid })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await loadRecipientsFor(owner, id)).toEqual([]);
    expect(await auditCount("report_recipients", rid)).toBe(3);
  });
});

describe("arkivering", () => {
  it("en butik med automat kan inte arkiveras; utan automat går det och kan ångras", async () => {
    const id = await newStore();
    const machineId = await asUser(ownerUser, async (tx) => {
      const [m] = await tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: `BU-${uniqueSuffix().slice(0, 4).toUpperCase()}`,
          name: "A",
          activeFrom: "2026-10-01",
        })
        .returning({ id: s.machines.id });
      await tx.insert(s.machinePlacements).values({
        organizationId: orgId,
        machineId: m!.id,
        storeId: id,
        validFrom: "2026-10-01",
      });
      return m!.id;
    });
    const blocked = await setStoreArchivedFor(owner, { storeId: id, archived: true });
    expect(blocked.ok).toBe(false);
    expect(blocked.ok ? "" : blocked.error).toMatch(/står i butiken/);
    expect(machineId).toBeTruthy();

    const empty = await newStore();
    expect(await setStoreArchivedFor(owner, { storeId: empty, archived: true })).toEqual({
      ok: true,
      data: undefined,
    });
    expect((await loadStoresFor(owner)).find((x) => x.id === empty)?.archived).toBe(true);
    expect(await setStoreArchivedFor(owner, { storeId: empty, archived: false })).toEqual({
      ok: true,
      data: undefined,
    });
    expect((await loadStoresFor(owner)).find((x) => x.id === empty)?.archived).toBe(false);
  });
});
