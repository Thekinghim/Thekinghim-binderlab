/**
 * Månadsavräkning per butik (20261104233400_butik_avrakning.sql, src/server/settlements)
 * och butiksportalens avräkningar och avtal mot testdatabasen:
 *
 * - jobbet och "skapa saknade" ger en avräkning per butik och månad, kan köras om, och
 *   beloppet är samma som butikens andel i bokföringsunderlaget (ingen egen uträkning),
 * - betald: datum, vem och när sätts av databasen, beloppet låses, ångra, framtida datum,
 * - roller: läsaren läser men ändrar inte, påfyllaren och butiken ser inte tabellen,
 *   en annan organisation ser och ändrar ingenting, klienten kan inte förfalska vem,
 * - portalen: butiken ser bara sina avräkningar och sitt avtal (portal_settlements,
 *   portal_contracts, portal_contract_file), aldrig en annan butiks, och anon ingenting,
 * - Att göra har en punkt för obetalda avräkningar tills de är betalda.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor, withUserDbFor, type SessionUser } from "@/server/access";
import { queryPortalStores } from "@/server/portal/queries";
import type { PortalContext } from "@/server/portal/session";
import { loadPortalContractFile, loadPortalSettlementDocument } from "@/server/portal/settlements";
import { AuthorizationError } from "@/server/access";
import { loadTodosFor, type Viewer } from "@/server/data/core/loaders";
import { buildSnapshot } from "@/server/reports/snapshot";
import { loadSnapshotInput } from "@/server/reports/sources";
import {
  createMonthlySettlements,
  ensureSettlementsFor,
  loadSettlementPageFor,
  markSettlementPaidFor,
  recomputeSettlementFor,
  settlementDocumentFor,
  SettlementError,
  undoSettlementPaidFor,
} from "@/server/settlements/service";

import {
  asAnon,
  asPostgres,
  asUser,
  attempt,
  createMember,
  db,
  one,
  rows,
  type TestUser,
} from "./helpers";
import { inviteStoreUser, seedPortalTenant, type PortalTenant } from "./portal-fixture";

// Fixturens order ligger i mars 2025; den 2 april avräknas mars.
const APRIL = new Date("2025-04-02T08:00:00Z");

let a: PortalTenant;
let b: PortalTenant;
let ownerA: Viewer;
let ownerB: Viewer;
let viewerA: TestUser;
let refillerA: TestUser;
let storeA: TestUser;
let storeB: TestUser;
let settlementA: string;

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

async function rejects(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

beforeAll(async () => {
  a = await seedPortalTenant("ICA Avräkning");
  b = await seedPortalTenant("Hemköp Avräkning");
  ownerA = await viewerFor(a.owner, a.orgId);
  ownerB = await viewerFor(b.owner, b.orgId);
  viewerA = await createMember(a.orgId, "viewer");
  refillerA = await createMember(a.orgId, "refiller");
  storeA = await inviteStoreUser(a.owner, a.orgId, a.storeId);
  storeB = await inviteStoreUser(b.owner, b.orgId, b.storeId);
});

describe("skapa avräkningar", () => {
  it("jobbet skapar en avräkning per butik för förra månaden och kan köras om", async () => {
    const [first] = await createMonthlySettlements(db(), APRIL, { organizationIds: [a.orgId] });
    expect(first).toMatchObject({ organizationId: a.orgId, month: "2025-03", created: 1 });
    expect(first!.errors).toEqual([]);
    const [again] = await createMonthlySettlements(db(), APRIL, { organizationIds: [a.orgId] });
    expect(again).toMatchObject({ created: 0, skipped: 1 });
    const list = await asPostgres((tx) =>
      rows<{ id: string; month: string; amount_ore: string; paid_on: string | null }>(
        tx,
        sql`select id, month::text as month, amount_ore, paid_on
            from public.store_settlements where organization_id = ${a.orgId}`,
      ),
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.month).toBe("2025-03-01");
    expect(list[0]!.paid_on).toBeNull();
    settlementA = list[0]!.id;
  });

  it("beloppet är butikens andel i bokföringsunderlaget (samma uträkning, ingen dubbelräkning)", async () => {
    const accountant = await asPostgres(async (tx) =>
      buildSnapshot(
        await loadSnapshotInput(tx, {
          organizationId: a.orgId,
          type: "bokforing",
          month: "2025-03",
          now: APRIL.toISOString(),
        }),
      ),
    );
    if (accountant.type !== "bokforing") throw new Error("fel typ");
    const share = accountant.report.stores.find((x) => x.storeId === a.storeId)!;
    const { amount_ore } = await asPostgres((tx) =>
      one<{ amount_ore: string }>(
        tx,
        sql`select amount_ore from public.store_settlements where id = ${settlementA}`,
      ),
    );
    // 20 % provision på (79 + 89 kr) exkl. moms.
    expect(Number(amount_ore)).toBe(share.compensationOre);
    expect(Number(amount_ore)).toBeGreaterThan(0);
  });

  it("ägaren skapar saknade som sig själv; läsaren skapar inget", async () => {
    const run = await ensureSettlementsFor(ownerB, APRIL);
    expect(run).toMatchObject({ month: "2025-03", created: 1, errors: [] });
    const v = await viewerFor(viewerA, a.orgId);
    expect(await ensureSettlementsFor(v, APRIL)).toBeNull();
    const { created_by } = await asPostgres((tx) =>
      one<{ created_by: string }>(
        tx,
        sql`select created_by from public.store_settlements where organization_id = ${b.orgId}`,
      ),
    );
    expect(created_by).toBe(b.owner.id);
  });

  it("sidan visar avräkningen och butikens portaltillgång", async () => {
    const page = await loadSettlementPageFor(ownerA, APRIL);
    expect(page.canEdit).toBe(true);
    expect(page.rows.map((r) => r.id)).toEqual([settlementA]);
    expect(page.rows[0]!.state).toBe("unpaid");
    expect(page.rows[0]!.statement?.storeName).toBe("ICA Avräkning");
    expect(page.portal?.find((p) => p.storeId === a.storeId)).toMatchObject({ users: 1 });
    const asViewer = await loadSettlementPageFor(await viewerFor(viewerA, a.orgId), APRIL);
    expect(asViewer.canEdit).toBe(false);
    expect(asViewer.portal).toBeNull();
    expect(asViewer.rows).toHaveLength(1);
  });
});

describe("betald", () => {
  it("Att göra visar den obetalda avräkningen", async () => {
    const todos = await loadTodosFor(ownerA, new Date("2025-04-03T08:00:00Z"));
    const t = todos.find((x) => x.kind === "settlement");
    expect(t?.key).toBe("settlement:2025-03");
    expect(t?.link).toBe("/butiker?vy=utbetalning&manad=2025-03");
  });

  it("markera som betald: databasen sätter vem och när och låser beloppet", async () => {
    const res = await markSettlementPaidFor(ownerA, settlementA, "2025-04-05");
    expect(res.storeName).toBe("ICA Avräkning");
    const row = await asPostgres((tx) =>
      one<{ paid_on: string; paid_by: string; paid_marked_at: Date | null }>(
        tx,
        sql`select paid_on::text as paid_on, paid_by, paid_marked_at
            from public.store_settlements where id = ${settlementA}`,
      ),
    );
    expect(row).toMatchObject({ paid_on: "2025-04-05", paid_by: a.owner.id });
    expect(row.paid_marked_at).not.toBeNull();

    expect(await rejects(markSettlementPaidFor(ownerA, settlementA, "2025-04-06"))).toBeInstanceOf(
      SettlementError,
    );
    expect(await rejects(recomputeSettlementFor(ownerA, settlementA, APRIL))).toBeInstanceOf(
      SettlementError,
    );
    const locked = await asUser(a.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.store_settlements set amount_ore = 1 where id = ${settlementA}`,
        ),
      ),
    );
    expect(locked).toMatchObject({ ok: false, code: "BL081" });

    const todos = await loadTodosFor(ownerA, new Date("2025-04-06T08:00:00Z"));
    expect(todos.some((x) => x.kind === "settlement")).toBe(false);
  });

  it("ångra, framtida datum och datum före månaden", async () => {
    await undoSettlementPaidFor(ownerA, settlementA);
    const { paid_on, paid_by } = await asPostgres((tx) =>
      one<{ paid_on: string | null; paid_by: string | null }>(
        tx,
        sql`select paid_on, paid_by from public.store_settlements where id = ${settlementA}`,
      ),
    );
    expect(paid_on).toBeNull();
    expect(paid_by).toBeNull();
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect(await rejects(markSettlementPaidFor(ownerA, settlementA, future))).toBeInstanceOf(
      SettlementError,
    );
    const before = await asUser(a.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.store_settlements set paid_on = '2025-02-01' where id = ${settlementA}`,
        ),
      ),
    );
    expect(before).toMatchObject({ ok: false, code: "23514" });
  });

  it("räkna om en obetald ger samma belopp med samma underlag", async () => {
    const res = await recomputeSettlementFor(ownerA, settlementA, APRIL);
    expect(res.amountOre).toBe(res.previousOre);
  });

  it("klienten kan inte förfalska vem som betalade eller ändra butik", async () => {
    const forged = await asUser(a.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.store_settlements set paid_by = ${b.owner.id} where id = ${settlementA}`,
        ),
      ),
    );
    expect(forged).toMatchObject({ ok: false, code: "42501" });
    const moved = await asUser(a.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.store_settlements set store_id = ${b.storeId} where id = ${settlementA}`,
        ),
      ),
    );
    expect(moved.ok).toBe(false);
    const deleted = await asUser(a.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`delete from public.store_settlements where id = ${settlementA}`),
      ),
    );
    expect(deleted.ok).toBe(false);
  });
});

describe("roller och organisationer", () => {
  it("läsaren läser men ändrar inte", async () => {
    const v = await viewerFor(viewerA, a.orgId);
    expect(await rejects(markSettlementPaidFor(v, settlementA, "2025-04-05"))).toBeInstanceOf(
      AuthorizationError,
    );
    const n = await asUser(viewerA, (tx) =>
      tx.execute(
        sql`update public.store_settlements set paid_on = '2025-04-05' where id = ${settlementA}`,
      ),
    );
    expect((n as unknown as { count: number }).count).toBe(0);
    expect((await settlementDocumentFor(v, settlementA)).html).toContain("ICA Avräkning");
  });

  it("påfyllaren och butiksanvändaren ser inte tabellen", async () => {
    for (const u of [refillerA, storeA]) {
      const seen = await asUser(u, (tx) =>
        rows(tx, sql`select id from public.store_settlements where organization_id = ${a.orgId}`),
      );
      expect(seen).toEqual([]);
    }
  });

  it("en annan organisation ser och ändrar ingenting", async () => {
    expect(await rejects(markSettlementPaidFor(ownerB, settlementA, "2025-04-05"))).toBeInstanceOf(
      SettlementError,
    );
    expect(await rejects(settlementDocumentFor(ownerB, settlementA))).toBeInstanceOf(
      SettlementError,
    );
    expect(await rejects(recomputeSettlementFor(ownerB, settlementA, APRIL))).toBeInstanceOf(
      SettlementError,
    );
    const seen = await asUser(b.owner, (tx) =>
      rows(tx, sql`select id from public.store_settlements where id = ${settlementA}`),
    );
    expect(seen).toEqual([]);
    const inserted = await asUser(b.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.store_settlements
                (organization_id, store_id, month, amount_ore, statement, calc_version)
              values (${a.orgId}, ${a.storeId}, '2025-02-01', 1, '{}'::jsonb, 'x')`,
        ),
      ),
    );
    expect(inserted.ok).toBe(false);
  });
});

describe("butiksportalen", () => {
  let contractA: string;
  let contractB: string;

  beforeAll(async () => {
    [contractA, contractB] = await asPostgres(async (tx) => {
      const ca = await one<{ id: string }>(
        tx,
        sql`insert into public.contracts (organization_id, store_id, valid_from, storage_path,
                                          file_content_type, title)
            values (${a.orgId}, ${a.storeId}, '2025-01-01',
                    ${`${a.orgId}/contracts/${"a".repeat(64)}.pdf`}, 'application/pdf', 'Placeringsavtal')
            returning id`,
      );
      const cb = await one<{ id: string }>(
        tx,
        sql`insert into public.contracts (organization_id, store_id, valid_from, storage_path,
                                          file_content_type)
            values (${b.orgId}, ${b.storeId}, '2025-01-01',
                    ${`${b.orgId}/contracts/${"b".repeat(64)}.pdf`}, 'application/pdf')
            returning id`,
      );
      return [ca.id, cb.id];
    });
  });

  it("butiken ser sina avräkningar, utan andra butikers", async () => {
    const list = await asUser(storeA, (tx) =>
      rows<{ settlement_id: string; amount_ore: string; statement: { storeName: string } }>(
        tx,
        sql`select * from public.portal_settlements(${a.storeId}::uuid)`,
      ),
    );
    expect(list.map((r) => r.settlement_id)).toEqual([settlementA]);
    expect(list[0]!.statement.storeName).toBe("ICA Avräkning");
    const other = await asUser(storeA, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select * from public.portal_settlements(${b.storeId}::uuid)`),
      ),
    );
    expect(other).toMatchObject({ ok: false, code: "42501" });
    const ownerAsStore = await asUser(a.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select * from public.portal_settlements(${a.storeId}::uuid)`),
      ),
    );
    expect(ownerAsStore).toMatchObject({ ok: false, code: "42501" });
  });

  it("butiken ser sitt avtal och hämtar bara sin egen fil", async () => {
    const list = await asUser(storeA, (tx) =>
      rows<{ contract_id: string; has_file: boolean }>(
        tx,
        sql`select * from public.portal_contracts(${a.storeId}::uuid)`,
      ),
    );
    expect(list).toEqual([expect.objectContaining({ contract_id: contractA, has_file: true })]);
    const file = await asUser(storeA, (tx) =>
      one<{ storage_path: string; signed: boolean }>(
        tx,
        sql`select * from public.portal_contract_file(${a.storeId}::uuid, ${contractA}::uuid)`,
      ),
    );
    expect(file.storage_path).toContain(a.orgId);
    expect(file.signed).toBe(false);
    // Ett avtal i en annan organisation med den egna butiken: som ett okänt id.
    const foreign = await asUser(storeA, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select * from public.portal_contract_file(${a.storeId}::uuid, ${contractB}::uuid)`,
        ),
      ),
    );
    expect(foreign).toMatchObject({ ok: false, code: "P0002" });
    const otherStore = await asUser(storeA, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select * from public.portal_contract_file(${b.storeId}::uuid, ${contractB}::uuid)`,
        ),
      ),
    );
    expect(otherStore).toMatchObject({ ok: false, code: "42501" });
    const bSees = await asUser(storeB, (tx) =>
      rows(tx, sql`select * from public.portal_contracts(${b.storeId}::uuid)`),
    );
    expect(bSees).toHaveLength(1);
  });

  async function portalCtx(u: TestUser): Promise<PortalContext> {
    const user: SessionUser = { userId: u.id, email: u.email };
    const stores = await withUserDbFor(user, queryPortalStores);
    return { user, store: stores[0]!, stores };
  }

  it("avräkningens PDF: bara butikens egen, manipulerat id ger inget", async () => {
    const ctxA = await portalCtx(storeA);
    const ctxB = await portalCtx(storeB);
    const doc = await loadPortalSettlementDocument(ctxA, settlementA);
    expect(doc?.html).toContain("ICA Avräkning");
    expect(doc?.fileName).toBe("avrakning-ica-avrakning-2025-03.pdf");
    expect(await loadPortalSettlementDocument(ctxB, settlementA)).toBeNull();
    expect(await loadPortalSettlementDocument(ctxA, `${settlementA}x`)).toBeNull();
    expect(await loadPortalSettlementDocument(ctxA, "../../etc/passwd")).toBeNull();
    // En butik med en annan butiks id i sitt sammanhang: databasen säger nej.
    const forged = { ...ctxB, store: { ...ctxB.store, storeId: a.storeId } };
    expect(await rejects(loadPortalSettlementDocument(forged, settlementA))).toBeTruthy();
  });

  it("avtalsfilen: egen fil hämtas med systemnyckeln, andras aldrig", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "avtal-"));
    process.env.CONTRACT_FILE_STORE = "local";
    process.env.CONTRACT_FILE_DIR = dir;
    const files = new LocalFileStore(dir);
    const bytes = new TextEncoder().encode("%PDF-1.4 avtal A");
    await files.put(`${a.orgId}/contracts/${"a".repeat(64)}.pdf`, bytes);
    await files.put(`${b.orgId}/contracts/${"b".repeat(64)}.pdf`, new TextEncoder().encode("B"));
    const ctxA = await portalCtx(storeA);
    const file = await loadPortalContractFile(ctxA, contractA);
    expect(file?.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(file!.bytes)).toBe("%PDF-1.4 avtal A");
    expect(await loadPortalContractFile(ctxA, contractB)).toBeNull();
    expect(await loadPortalContractFile(ctxA, "inte-ett-id")).toBeNull();
  });

  it("anon kan inte köra portalens nya funktioner", async () => {
    for (const q of [
      sql`select * from public.portal_settlements(${a.storeId}::uuid)`,
      sql`select * from public.portal_contracts(${a.storeId}::uuid)`,
      sql`select * from public.portal_contract_file(${a.storeId}::uuid, ${contractA}::uuid)`,
      sql`select * from public.store_settlements`,
    ]) {
      const res = await asAnon((tx) => attempt(tx, (sp) => sp.execute(q)));
      expect(res).toMatchObject({ ok: false, code: "42501" });
    }
  });
});
