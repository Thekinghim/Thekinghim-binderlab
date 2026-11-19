/**
 * Butiksrapporten som underlag för butikens bokföring (20261217000000_rapport_underlag.sql).
 *
 * En butiks revisor godkände inte rapporten: den visade inte vilket bolag som betalar, och
 * inte om svensk moms gäller. Här kontrolleras mot riktig Postgres:
 *
 * 1. Inställningarna (momsregistreringsnummer och momsvalet): standard, vem som får ändra
 *    dem (roller, RLS, andra organisationer), och att ett ogiltigt nummer aldrig sparas.
 * 2. Uppgifterna läses när rapporten räknas och sparas i rapporten: vårt bolag, butikens
 *    undertecknade avtal för perioden och momsvalet.
 * 3. Rapporter säger vad som saknas (företagsnamn, organisationsnummer), och ett utkast
 *    blir inaktuellt när uppgifterna fylls i.
 * 4. En godkänd rapport ändras inte när inställningarna ändras.
 * 5. Butiksportalen får samma uppgifter (bara för den egna butiken), och inget annat nytt.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { updateCompanyDetailsFor } from "@/app/(app)/installningar/_lib/data";
import { basisText, type StoreBasis } from "@/reports";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import { readReportBasisSettings } from "@/server/contracts/operator";
import type { Viewer } from "@/server/data/core/loaders";
import { queryPortalReport } from "@/server/portal/queries";
import { loadReportsPage } from "@/server/reports/page-data";
import {
  approveReportFor,
  createReportFor,
  getReportFor,
  listArchiveFor,
  previewReportFor,
  staleDraftFor,
} from "@/server/reports/service";

import { affected, asPostgres, asUser, one, settle, type TestUser } from "./helpers";
import { seedPortalFixture, type PortalFixture } from "./portal-fixture";

const MONTH = "2025-03";
const session = (u: TestUser): SessionUser => ({ userId: u.id, email: u.email });

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user = session(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let f: PortalFixture;
let owner: Viewer;
let reader: Viewer;

const COMPANY = {
  companyName: "Binderlab AB",
  orgNumber: "559000-1234",
  companyAddress: "Storgatan 1, 111 22 Stockholm",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
};

const stored = (orgId: string) => asPostgres((tx) => readReportBasisSettings(tx, orgId));

async function basisOf(viewer: Viewer, id: string): Promise<StoreBasis | undefined> {
  const snap = (await getReportFor(viewer, id)).snapshot;
  if (snap.type !== "butik") throw new Error("fel typ");
  return snap.report.basis;
}

async function reportOf(id: string) {
  const snap = (await getReportFor(owner, id)).snapshot;
  if (snap.type !== "butik") throw new Error("fel typ");
  return snap.report;
}

const create = (storeId: string) =>
  createReportFor(owner, { type: "butik", month: MONTH, storeId });

async function archiveRow(id: string) {
  const row = (await listArchiveFor(owner)).find((r) => r.id === id);
  if (!row) throw new Error("rapporten saknas i arkivet");
  return row;
}

beforeAll(async () => {
  f = await seedPortalFixture();
  owner = await viewerFor(f.a.owner, f.a.orgId);
  reader = await viewerFor(f.viewerA, f.a.orgId);
});

describe("inställningarna", () => {
  it("standard: inget momsregistreringsnummer, moms tillkommer", async () => {
    expect(await stored(f.a.orgId)).toEqual({
      vatNumber: null,
      reportVatMode: "added",
      reportVmb: false,
      reportOwnsMachines: false,
    });
  });

  it("ett anrop utan de nya fälten (äldre kod) ändrar dem inte", async () => {
    await asPostgres((tx) =>
      tx.execute(sql`update public.organization_settings
                     set vat_number = 'SE111111111101', report_vat_mode = 'none'
                     where organization_id = ${f.b.orgId}::uuid`),
    );
    const res = await updateCompanyDetailsFor(session(f.b.owner), {
      organizationId: f.b.orgId,
      ...COMPANY,
      companyName: "Annan AB",
    });
    expect(res).toEqual({ ok: true, data: { changed: true } });
    expect(await stored(f.b.orgId)).toEqual({
      vatNumber: "SE111111111101",
      reportVatMode: "none",
      reportVmb: false,
      reportOwnsMachines: false,
    });
  });

  it("ett ogiltigt momsregistreringsnummer sparas inte (tjänsten och databasen)", async () => {
    const res = await updateCompanyDetailsFor(session(f.a.owner), {
      organizationId: f.a.orgId,
      ...COMPANY,
      vatNumber: "559000123401",
    });
    expect(res).toEqual({
      ok: false,
      error: "Momsregistreringsnummer skrivs SE, tio siffror och 01, t.ex. SE559000123401.",
    });
    const direct = await settle(
      asPostgres((tx) =>
        tx.execute(sql`update public.organization_settings set vat_number = 'SE12345'
                       where organization_id = ${f.a.orgId}::uuid`),
      ),
    );
    expect(direct.ok).toBe(false);
    const mode = await settle(
      asPostgres((tx) =>
        tx.execute(sql`update public.organization_settings set report_vat_mode = 'kanske'
                       where organization_id = ${f.a.orgId}::uuid`),
      ),
    );
    expect(mode.ok).toBe(false);
    expect(await stored(f.a.orgId)).toEqual({
      vatNumber: null,
      reportVatMode: "added",
      reportVmb: false,
      reportOwnsMachines: false,
    });
  });

  it("läsare, påfyllare och butiksanvändare får inte ändra (tjänsten och RLS)", async () => {
    for (const u of [f.viewerA, f.refillerA, f.storeA1, f.b.owner]) {
      const res = await updateCompanyDetailsFor(session(u), {
        organizationId: f.a.orgId,
        ...COMPANY,
        vatNumber: "SE559000123401",
        reportVatMode: "none",
      });
      expect(res.ok).toBe(false);
      const outcome = await settle(
        asUser(u, (tx) =>
          affected(
            tx,
            sql`update public.organization_settings
                set vat_number = 'SE559000123401', report_vat_mode = 'none'
                where organization_id = ${f.a.orgId}::uuid`,
          ),
        ),
      );
      if (outcome.ok) expect(outcome.value).toBe(0);
      else expect(outcome.code).toBe("42501");
    }
    expect(await stored(f.a.orgId)).toEqual({
      vatNumber: null,
      reportVatMode: "added",
      reportVmb: false,
      reportOwnsMachines: false,
    });
  });
});

describe("rapporten utan företagsuppgifter", () => {
  let draft: string;

  it("namnger organisationen, men säger vad som saknas", async () => {
    draft = await create(f.a.storeId);
    const basis = await basisOf(owner, draft);
    expect(basis).toEqual({
      rev: 2,
      payer: {
        name: owner.organization.name,
        legal: false,
        orgNumber: null,
        address: null,
        vatNumber: null,
        brand: null,
        ownsMachines: false,
      },
      recipientAddress: null,
      agreementForm: null,
      contract: null,
      vatMode: "added",
      vatRateBp: 2500,
      vmb: false,
      payments: [],
    });
    expect((await archiveRow(draft)).basisGaps).toEqual(["företagsnamn", "organisationsnummer"]);
    // Rapporter (granskningen) får samma uppgift.
    const page = await loadReportsPage(owner, { typ: "butik", manad: MONTH, butiken: f.a.storeId });
    expect(page.current?.id).toBe(draft);
    expect(page.current?.basisGaps).toEqual(["företagsnamn", "organisationsnummer"]);
    // Godkännandet låses inte av det.
    expect(await staleDraftFor(owner, draft)).toBeNull();
  });

  it("en rapport från före uppgifterna fanns: visar inte vem som betalar", async () => {
    // Samma rapport som den sparades förut: utan underlaget.
    const id = await asPostgres(async (tx) => {
      const row = await one<{ id: string }>(
        tx,
        sql`insert into public.reports (organization_id, kind, period_start, period_end, store_id,
                                        storage_path, data_snapshot, calc_version, generated_at)
            select organization_id, kind, period_start, period_end, store_id,
                   organization_id::text || '/reports/aldre-' || gen_random_uuid()::text || '.pdf',
                   data_snapshot #- '{report,basis}', calc_version, generated_at - interval '1 hour'
            from public.reports where id = ${draft}
            returning id`,
      );
      return row.id;
    });
    expect(await basisOf(owner, id)).toBeUndefined();
    const old = await archiveRow(id);
    expect(old.basisGaps).toBeNull();
  });

  it("utkastet blir inaktuellt när uppgifterna fylls i, och godkänns som ny version", async () => {
    const saved = await updateCompanyDetailsFor(owner.user, {
      organizationId: f.a.orgId,
      ...COMPANY,
      vatNumber: "se 559000-1234 01",
      reportVatMode: "added",
    });
    expect(saved).toEqual({ ok: true, data: { changed: true } });
    expect(await stored(f.a.orgId)).toEqual({
      vatNumber: "SE559000123401",
      reportVatMode: "added",
      reportVmb: false,
      reportOwnsMachines: false,
    });

    const stale = await staleDraftFor(owner, draft);
    expect(stale).not.toBeNull();
    // Beloppet är detsamma: det är underlaget som har ändrats.
    expect(stale!.draftOre).toBe(stale!.nowOre);
    const err = await approveReportFor(owner, draft, null).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "Rapporten har ändrats sedan utkastet skapades. Skapa en ny version och godkänn den.",
    );
    // Utkastet självt visar fortfarande det som sparades i det.
    expect((await basisOf(owner, draft))?.payer.legal).toBe(false);
  });
});

describe("rapporten med företagsuppgifter", () => {
  let approved: string;
  const PAYER = {
    name: "Binderlab AB",
    legal: true,
    orgNumber: "559000-1234",
    address: "Storgatan 1, 111 22 Stockholm",
    vatNumber: "SE559000123401",
  };

  it("sparar vårt bolag; utan undertecknat avtal påstås inget avtal", async () => {
    // Ett kontrakt från mallen som inte är undertecknat räknas inte.
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.contracts (organization_id, store_id, valid_from, title, template)
                     values (${f.a.orgId}, ${f.a.storeId}, '2025-01-01', 'Utkast', 'placering-v1')`),
    );
    const id = await create(f.a.storeId);
    const basis = await basisOf(owner, id);
    expect(basis).toEqual({
      rev: 2,
      // Organisationen heter något annat än bolaget: namnet står bredvid det juridiska.
      payer: { ...PAYER, brand: owner.organization.name, ownsMachines: false },
      recipientAddress: null,
      agreementForm: null,
      contract: null,
      vatMode: "added",
      vatRateBp: 2500,
      vmb: false,
      payments: [],
    });
    expect((await archiveRow(id)).basisGaps).toEqual([]);
    // Inget val och inget kontrakt: rapporten säger att avtalet saknas, påstår inget annat.
    const text = basisText(basis!, await reportOf(id), "ICA Testbutik").join("\n");
    expect(text).not.toMatch(/Enligt|Muntligt|Skriftligt/);
    expect(text).toContain("Avtal saknas i underlaget.");
  });

  it("det undertecknade avtalet för perioden står med namn och datum", async () => {
    await asPostgres((tx) =>
      tx.execute(sql`
        insert into public.contracts
          (organization_id, store_id, valid_from, valid_to, title, template, signed_at)
        values
          -- Gällde i mars 2025, undertecknat sent på kvällen den 9 januari svensk tid.
          (${f.a.orgId}, ${f.a.storeId}, '2025-01-03', null, 'Vinstdelningsavtal', 'placering-v1',
           '2025-01-09T22:30:00Z'),
          -- Slutade före perioden.
          (${f.a.orgId}, ${f.a.storeId}, '2024-01-01', '2024-12-31', 'Gammalt', 'placering-v1',
           '2023-12-20T10:00:00Z'),
          -- En annan butiks avtal.
          (${f.a.orgId}, ${f.a2.storeId}, '2025-02-01', null, 'Andra butikens', null, null)`),
    );
    approved = await create(f.a.storeId);
    const basis = await basisOf(owner, approved);
    expect(basis?.contract).toEqual({
      title: "Vinstdelningsavtal",
      validFrom: "2025-01-03",
      signedOn: "2025-01-09",
    });
    expect(basisText(basis!, await reportOf(approved), "ICA Testbutik")).toContain(
      "Enligt Vinstdelningsavtal från 3 januari 2025, undertecknat 9 januari 2025.",
    );
    // Den andra butiken: ett avtal registrerat för hand, utan dag för undertecknandet.
    const other = await previewReportFor(owner, {
      type: "butik",
      month: MONTH,
      storeId: f.a2.storeId,
    });
    expect(other.type === "butik" && other.report.basis?.contract).toEqual({
      title: "Andra butikens",
      validFrom: "2025-02-01",
      signedOn: null,
    });
  });

  it("läsaren ser samma förhandsvisning", async () => {
    const preview = await previewReportFor(reader, {
      type: "butik",
      month: MONTH,
      storeId: f.a.storeId,
    });
    expect(preview.type === "butik" && preview.report.basis?.payer).toMatchObject(PAYER);
  });

  it("en godkänd rapport ändras inte när inställningarna ändras", async () => {
    await approveReportFor(owner, approved, null);
    const before = await basisOf(owner, approved);
    const saved = await updateCompanyDetailsFor(owner.user, {
      organizationId: f.a.orgId,
      ...COMPANY,
      companyName: "Binderlab Nya AB",
      vatNumber: "",
      reportVatMode: "none",
    });
    expect(saved).toEqual({ ok: true, data: { changed: true } });
    expect(await basisOf(owner, approved)).toEqual(before);
    expect(before?.vatMode).toBe("added");
    // En ny rapport följer de nya inställningarna.
    const next = await create(f.a.storeId);
    const basis = await basisOf(owner, next);
    expect(basis?.payer).toMatchObject({ ...PAYER, name: "Binderlab Nya AB", vatNumber: null });
    expect(basis?.vatMode).toBe("none");
  });

  it("butiksportalen får samma uppgifter för sin egen rapport, och inget annat nytt", async () => {
    const portal = await asUser(f.storeA1, (tx) => queryPortalReport(tx, f.a.storeId, approved));
    const report = portal.report as { basis?: StoreBasis };
    expect(report.basis).toEqual(await basisOf(owner, approved));
    // Bara bolagets identitet, avtalet (form, namn och datum), momsvalen, butikens egna
    // utbetalningar och butikens egen adress.
    expect(Object.keys(report.basis!).sort()).toEqual([
      "agreementForm",
      "contract",
      "payer",
      "payments",
      "recipientAddress",
      "rev",
      "vatMode",
      "vatRateBp",
      "vmb",
    ]);
    expect(Object.keys(report.basis!.payer).sort()).toEqual([
      "address",
      "brand",
      "legal",
      "name",
      "orgNumber",
      "ownsMachines",
      "vatNumber",
    ]);
    // En annan butiks användare (samma organisation och en annan) når den inte.
    for (const [u, storeId] of [
      [f.storeA2, f.a2.storeId],
      [f.storeB1, f.b.storeId],
      [f.storeA2, f.a.storeId],
    ] as const) {
      const outcome = await settle(asUser(u, (tx) => queryPortalReport(tx, storeId, approved)));
      expect(outcome.ok).toBe(false);
    }
    // Butiksanvändaren kan inte läsa inställningarna själva.
    const direct = await settle(
      asUser(f.storeA1, (tx) =>
        one<{ n: number }>(
          tx,
          sql`select count(*)::int as n from public.organization_settings
              where organization_id = ${f.a.orgId}::uuid`,
        ),
      ),
    );
    if (direct.ok) expect(direct.value.n).toBe(0);
    else expect(direct.code).toBe("42501");
  });
});
