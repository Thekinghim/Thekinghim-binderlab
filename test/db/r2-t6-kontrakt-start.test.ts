/**
 * Runda 2, T6-2 mot testdatabasen: "Ändra start till 14 okt." på Kontrakt
 * (src/app/(app)/avtal/_lib/start-move.ts). Kontraktet och dess villkor får första dagen
 * med försäljning utan signerat kontrakt, i en transaktion och bara för ägare och admin;
 * PDF:en skrivs ut på nytt så att en redan skickad signeringslänk slutar gälla; och när
 * kontraktet sedan signeras finns ingen försäljning utan signerat kontrakt kvar.
 */

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { startFix, uncoveredSales } from "@/app/(app)/avtal/_lib/model";
import { moveContractStartFor, StartMoveError } from "@/app/(app)/avtal/_lib/start-move";
import * as s from "@/db/schema";
import { LocalFileStore } from "@/import/file-store";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import { loadContractsFor } from "@/server/accounting";
import {
  createSigningLinkFor,
  createStoreContractFor,
  describeSigningLink,
  loadStoreSalesFor,
  setContractStatusFor,
  type Viewer,
} from "@/server/contracts";

import { asUser, createMember, one, type TestUser } from "./helpers";
import { awishCsv, mapMachine, setupImportOrg, type ImportFixture } from "./import-fixtures";

const TODAY = "2026-11-03";

let f: ImportFixture;
let owner: Viewer;
let files: LocalFileStore;
let rendered: string[] = [];

/** En "PDF" vars innehåll följer HTML:en, så att en ny utskrift får en ny kontrollsumma. */
const renderPdf = async (html: string) => {
  rendered.push(html);
  return new TextEncoder().encode(
    `%PDF-1.4\n% ${createHash("sha256").update(html).digest("hex")}\n`,
  );
};

const deps = () => ({ today: TODAY, renderPdf, fileStore: () => files });

async function viewerFor(u: TestUser): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === f.orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

/** Butik med en automat som stått där sedan `from`. */
async function storeWithMachine(name: string, external: string, code: string, from: string) {
  const machineId = await mapMachine(f, external, code);
  return asUser(f.owner, async (tx) => {
    const store = await one<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name)
          values (${f.orgId}::uuid, ${name}) returning id`,
    );
    await tx.execute(
      sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
          values (${f.orgId}::uuid, ${machineId}::uuid, ${store.id}::uuid, ${from})`,
    );
    return store.id;
  });
}

async function contractRow(id: string) {
  const [c] = await asUser(f.owner, (tx) =>
    tx.select().from(s.contracts).where(eq(s.contracts.id, id)),
  );
  return c!;
}

async function termsOf(storeId: string) {
  return asUser(f.owner, (tx) =>
    tx
      .select()
      .from(s.storeAgreements)
      .where(
        and(eq(s.storeAgreements.organizationId, f.orgId), eq(s.storeAgreements.storeId, storeId)),
      )
      .orderBy(s.storeAgreements.validFrom),
  );
}

/** Varningen som sidan räknar den: försäljning utan signerat kontrakt för butiken. */
async function uncoveredFor(storeId: string) {
  const [data, sales] = await Promise.all([
    loadContractsFor(owner, TODAY, { overview: false }),
    loadStoreSalesFor(owner),
  ]);
  return (
    uncoveredSales({
      stores: data.stores
        .filter((st) => st.id === storeId)
        .map((st) => ({ id: st.id, name: st.name })),
      sales,
      contracts: data.contracts.map((c) => ({
        id: c.id,
        storeId: c.storeId,
        validFrom: c.validFrom,
        validTo: c.validTo,
        noticeMonths: c.noticePeriodMonths,
        noticeDays: c.noticePeriodDays,
        renewalMonths: c.renewalMonths,
        terminatedOn: c.terminatedOn,
        template: c.template,
        sentAt: c.sentAt,
        signedAt: c.signedAt,
        hasFile: c.hasFile,
        archived: c.archived,
      })),
      today: TODAY,
    })[0] ?? null
  );
}

beforeAll(async () => {
  f = await setupImportOrg();
  owner = await viewerFor(f.owner);
  files = new LocalFileStore(mkdtempSync(path.join(tmpdir(), "kontrakt-start-")));
});

describe("Ändra start till första försäljningsdagen", () => {
  let storeId: string;
  let contractId: string;
  let oldToken: string;

  beforeAll(async () => {
    storeId = await storeWithMachine("Sega gubben", "BL-001 Sega", "BL-001", "2026-10-14");
    // Sålt 14 okt. – 2 nov. (klockslagen är källans, Asia/Shanghai).
    const r = await f.run(
      awishCsv([
        { no: "1", machine: "BL-001 Sega", time: "2026-10-14 18:00:00" },
        { no: "2", machine: "BL-001 Sega", time: "2026-10-20 18:00:00" },
        { no: "3", machine: "BL-001 Sega", time: "2026-11-02 18:00:00" },
      ]),
    );
    expect(r.summary?.new).toBe(3);
    const res = await createStoreContractFor(
      owner,
      { target: `store:${storeId}`, validFrom: TODAY },
      { today: TODAY, renderPdf, fileStore: files },
    );
    if (!res.ok) throw new Error(res.message);
    contractId = res.contractId;
    // En signeringslänk är redan skickad, med PDF:en som säger 3 nov.
    oldToken = (await createSigningLinkFor(owner, contractId, { renderPdf, fileStore: files }))
      .token;
  });

  it("före: försäljningen sedan 14 okt. saknar signerat kontrakt, och knappen erbjuds", async () => {
    const u = await uncoveredFor(storeId);
    expect(u).toMatchObject({ from: "2026-10-14", unsignedId: contractId, unsignedFrom: TODAY });
    expect(startFix(u!, TODAY)).toMatchObject({ contractId, to: "2026-10-14" });
    expect((await describeSigningLink(oldToken)).status).toBe("valid");
  });

  it("läsaren och påfyllaren får inte ändra", async () => {
    for (const role of ["viewer", "refiller"] as const) {
      const member = await viewerFor(await createMember(f.orgId, role));
      await expect(moveContractStartFor(member, contractId, deps())).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    }
    expect((await contractRow(contractId)).validFrom).toBe(TODAY);
  });

  it("knappen flyttar kontraktet och villkoren till 14 okt. och skriver ut PDF:en på nytt", async () => {
    rendered = [];
    const result = await moveContractStartFor(owner, contractId, deps());
    expect(result).toEqual({ to: "2026-10-14", termsMoved: true, pdf: "updated" });
    expect((await contractRow(contractId)).validFrom).toBe("2026-10-14");
    const terms = await termsOf(storeId);
    expect(terms.map((t) => [t.validFrom, t.contractId])).toEqual([["2026-10-14", contractId]]);
    // PDF:en säger den nya dagen, och den gamla länken (med 3 nov.) går inte att signera med.
    expect(rendered[0]).toContain("14 oktober 2026");
    expect(rendered[0]).not.toContain("3 november 2026");
    expect((await describeSigningLink(oldToken)).status).toBe("changed");
  });

  it("efteråt finns inget kvar att rätta; signerat täcker det hela försäljningen", async () => {
    const u = await uncoveredFor(storeId);
    expect(u).toMatchObject({ from: "2026-10-14", unsignedFrom: "2026-10-14" });
    expect(startFix(u!, TODAY)).toBeNull();
    await expect(moveContractStartFor(owner, contractId, deps())).rejects.toThrow(
      "Startdagen behöver inte ändras",
    );
    await setContractStatusFor(owner, { id: contractId, status: "signed" });
    expect(await uncoveredFor(storeId)).toBeNull();
    await expect(moveContractStartFor(owner, contractId, deps())).rejects.toThrow(
      "Kontraktet är redan signerat.",
    );
  });
});

describe("När villkoren inte kan flyttas med", () => {
  it("samma villkor gällde redan de dagarna: bara kontraktet flyttas", async () => {
    const storeId = await storeWithMachine("Kafé Ett", "BL-002 Kafé", "BL-002", "2026-10-14");
    await f.run(awishCsv([{ no: "11", machine: "BL-002 Kafé", time: "2026-10-15 18:00:00" }]));
    // Butikens villkor från Ny butik (50 % av vinsten, från 14 okt.). Kontraktet från 3 nov.
    // avslutar dem 2 nov. och får egna, likadana villkor.
    await asUser(f.owner, (tx) =>
      tx.execute(
        sql`insert into public.store_agreements
              (organization_id, store_id, valid_from, commission_bp, commission_base)
            values (${f.orgId}::uuid, ${storeId}::uuid, '2026-10-14', 5000, 'profit_after_costs')`,
      ),
    );
    const res = await createStoreContractFor(
      owner,
      { target: `store:${storeId}`, validFrom: TODAY, confirmHistory: true },
      { today: TODAY, renderPdf, fileStore: files },
    );
    if (!res.ok) throw new Error(res.message);
    const before = await termsOf(storeId);
    expect(before.map((t) => [t.validFrom, t.validTo])).toEqual([
      ["2026-10-14", "2026-11-02"],
      [TODAY, null],
    ]);
    const result = await moveContractStartFor(owner, res.contractId, deps());
    expect(result).toMatchObject({ to: "2026-10-15", termsMoved: false });
    expect((await contractRow(res.contractId)).validFrom).toBe("2026-10-15");
    expect((await termsOf(storeId)).map((t) => [t.validFrom, t.validTo])).toEqual([
      ["2026-10-14", "2026-11-02"],
      [TODAY, null],
    ]);
  });

  it("andra villkor de dagarna: ingenting ändras och felet säger vad som är i vägen", async () => {
    const storeId = await storeWithMachine("Butik Tre", "BL-003 Tre", "BL-003", "2026-10-14");
    await f.run(awishCsv([{ no: "21", machine: "BL-003 Tre", time: "2026-10-14 18:00:00" }]));
    await asUser(f.owner, (tx) =>
      tx.execute(
        sql`insert into public.store_agreements
              (organization_id, store_id, valid_from, commission_bp, commission_base)
            values (${f.orgId}::uuid, ${storeId}::uuid, '2026-10-14', 3000, 'profit_after_costs')`,
      ),
    );
    const res = await createStoreContractFor(
      owner,
      { target: `store:${storeId}`, validFrom: TODAY, confirmHistory: true },
      { today: TODAY, renderPdf, fileStore: files },
    );
    if (!res.ok) throw new Error(res.message);
    const error = await moveContractStartFor(owner, res.contractId, deps()).catch((e) => e);
    expect(error).toBeInstanceOf(StartMoveError);
    expect(String(error.message).replace(/ /g, " ")).toBe(
      "Butik Tre har andra villkor från 14 okt. Ändra dem under Butiker först.",
    );
    expect((await contractRow(res.contractId)).validFrom).toBe(TODAY);
  });

  it("utan PDF-utskrift: startdagen ändras och svaret säger att PDF:en är gammal", async () => {
    const storeId = await storeWithMachine("Ny plats", "BL-004 Ny", "BL-004", "2026-10-14");
    await f.run(awishCsv([{ no: "31", machine: "BL-004 Ny", time: "2026-10-14 18:00:00" }]));
    const res = await createStoreContractFor(
      owner,
      { target: `store:${storeId}`, validFrom: TODAY },
      { today: TODAY, renderPdf, fileStore: files },
    );
    if (!res.ok) throw new Error(res.message);
    const result = await moveContractStartFor(owner, res.contractId, {
      today: TODAY,
      renderPdf: null,
      fileStore: () => files,
    });
    expect(result).toEqual({ to: "2026-10-14", termsMoved: true, pdf: "stale" });
  });
});
