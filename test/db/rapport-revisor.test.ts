/**
 * Butiksrapporten som revisorn ska kunna godkänna (steg 2 efter rapport-underlag.test.ts):
 * VMB-valet, avtalets form per butik, betalda avräkningar och namnet verksamheten kallas.
 * Migreringar 20261218000000_rapport_vmb.sql och 20261218000100_avtalsform.sql.
 *
 * Mot riktig Postgres:
 * 1. "Vi säljer med vinstmarginalbeskattning (VMB)": standard av, vem som får ändra, och
 *    att äldre anrop inte ändrar valet.
 * 2. Avtalets form: standard inte valt, vem som får ändra (tjänsten, RLS), ogiltiga värden.
 * 3. Rapporten sparar allt när den räknas: muntligt går före ett undertecknat kontrakt,
 *    granskningen varnar när inget avtal står, betalda avräkningar blir "Redan betalt".
 * 4. Ett utkast blir inaktuellt när valen eller betalningen ändras; en godkänd rapport
 *    ändras inte.
 * 5. Butiksportalen får samma rapport, och ser inga andra butikers betalningar.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { setStoreAgreementFormFor } from "@/app/(app)/butiker/_lib/service";
import { updateCompanyDetailsFor } from "@/app/(app)/installningar/_lib/data";
import {
  agreementLine,
  agreementText,
  basisText,
  invoiceRows,
  vmbStatement,
  withoutVmbStatement,
  type StoreBasis,
} from "@/reports";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import { readReportBasisSettings } from "@/server/contracts/operator";
import type { Viewer } from "@/server/data/core/loaders";
import { queryPortalReport } from "@/server/portal/queries";
import {
  approveReportFor,
  createReportFor,
  getReportFor,
  listArchiveFor,
  previewReportFor,
  staleDraftFor,
} from "@/server/reports/service";
import { markSettlementPaidFor } from "@/server/settlements/service";

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
  companyName: "Kortautomater i Norden AB",
  orgNumber: "559000-1234",
  companyAddress: "Storgatan 1, 111 22 Stockholm",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
};

const stored = (orgId: string) => asPostgres((tx) => readReportBasisSettings(tx, orgId));
const formOf = async (storeId: string) =>
  (
    await asPostgres((tx) =>
      one<{ form: string | null }>(
        tx,
        sql`select agreement_form as form from public.stores where id = ${storeId}`,
      ),
    )
  ).form;

async function snapshotOf(viewer: Viewer, id: string) {
  const snap = (await getReportFor(viewer, id)).snapshot;
  if (snap.type !== "butik") throw new Error("fel typ");
  return snap;
}
const basisOf = async (viewer: Viewer, id: string) => (await snapshotOf(viewer, id)).report.basis;

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
  const saved = await updateCompanyDetailsFor(owner.user, {
    organizationId: f.a.orgId,
    ...COMPANY,
    vatNumber: "SE559000123401",
    reportVatMode: "added",
  });
  expect(saved.ok).toBe(true);
});

describe("Vi säljer med vinstmarginalbeskattning (VMB)", () => {
  it("standard av; ett anrop utan fältet (äldre kod) ändrar det inte", async () => {
    expect((await stored(f.a.orgId)).reportVmb).toBe(false);
    await asPostgres((tx) =>
      tx.execute(sql`update public.organization_settings set report_vmb = true
                     where organization_id = ${f.b.orgId}::uuid`),
    );
    const res = await updateCompanyDetailsFor(session(f.b.owner), {
      organizationId: f.b.orgId,
      ...COMPANY,
      companyName: "Annan AB",
    });
    expect(res).toEqual({ ok: true, data: { changed: true } });
    expect((await stored(f.b.orgId)).reportVmb).toBe(true);
  });

  it("läsare, påfyllare och butiksanvändare får inte ändra (tjänsten och RLS)", async () => {
    for (const u of [f.viewerA, f.refillerA, f.storeA1, f.b.owner]) {
      const res = await updateCompanyDetailsFor(session(u), {
        organizationId: f.a.orgId,
        ...COMPANY,
        reportVmb: true,
      });
      expect(res.ok).toBe(false);
      const outcome = await settle(
        asUser(u, (tx) =>
          affected(
            tx,
            sql`update public.organization_settings set report_vmb = true
                where organization_id = ${f.a.orgId}::uuid`,
          ),
        ),
      );
      if (outcome.ok) expect(outcome.value).toBe(0);
      else expect(outcome.code).toBe("42501");
    }
    expect((await stored(f.a.orgId)).reportVmb).toBe(false);
  });

  it("ägaren slår på: nästa rapport säger det, och utkastet från förut blir inaktuellt", async () => {
    const draft = await create(f.a.storeId);
    expect((await basisOf(owner, draft))?.vmb).toBe(false);
    const saved = await updateCompanyDetailsFor(owner.user, {
      organizationId: f.a.orgId,
      ...COMPANY,
      reportVmb: true,
    });
    expect(saved).toEqual({ ok: true, data: { changed: true } });
    expect(await stored(f.a.orgId)).toEqual({
      vatNumber: "SE559000123401",
      reportVatMode: "added",
      reportVmb: true,
      reportOwnsMachines: false,
    });
    expect(await staleDraftFor(owner, draft)).not.toBeNull();
    // Utkastet självt står som det sparades.
    expect((await basisOf(owner, draft))?.vmb).toBe(false);

    const next = await create(f.a.storeId);
    const snap = await snapshotOf(owner, next);
    const basis = snap.report.basis!;
    expect(basis.vmb).toBe(true);
    const text = basisText(basis, snap.report, snap.store.name).join(" ");
    expect(text).toContain(vmbStatement("Kortautomater i Norden AB"));
    // Skatteregelns namn står bara i den fasta texten.
    expect(withoutVmbStatement(text, basis)).not.toMatch(/vinst|marginal/i);
  });
});

describe("avtalets form per butik", () => {
  it("standard: inte valt", async () => {
    expect(await formOf(f.a.storeId)).toBeNull();
  });

  it("läsare, påfyllare och butiksanvändare får inte ändra (tjänsten och RLS)", async () => {
    for (const u of [f.viewerA, f.refillerA, f.storeA1]) {
      const viewer: Viewer = { user: session(u), organization: owner.organization };
      const res = await setStoreAgreementFormFor(viewer, { storeId: f.a.storeId, form: "oral" });
      expect(res).toEqual({ ok: false, error: "Bara ägare och admin kan ändra butiker." });
    }
    for (const u of [f.viewerA, f.refillerA, f.storeA1, f.storeB1, f.b.owner]) {
      const outcome = await settle(
        asUser(u, (tx) =>
          affected(
            tx,
            sql`update public.stores set agreement_form = 'oral' where id = ${f.a.storeId}`,
          ),
        ),
      );
      if (outcome.ok) expect(outcome.value).toBe(0);
      else expect(outcome.code).toBe("42501");
    }
    expect(await formOf(f.a.storeId)).toBeNull();
  });

  it("bara Skriftligt avtal, Muntligt avtal eller inte valt (tjänsten och databasen)", async () => {
    const bad = await setStoreAgreementFormFor(owner, { storeId: f.a.storeId, form: "kanske" });
    expect(bad.ok).toBe(false);
    const direct = await settle(
      asPostgres((tx) =>
        tx.execute(
          sql`update public.stores set agreement_form = 'kanske' where id = ${f.a.storeId}`,
        ),
      ),
    );
    expect(direct.ok).toBe(false);
    // En annan organisations butik går inte att nå.
    const other = await setStoreAgreementFormFor(owner, { storeId: f.b.storeId, form: "oral" });
    expect(other).toEqual({ ok: false, error: "Butiken finns inte." });
    expect(await formOf(f.b.storeId)).toBeNull();
  });

  it("inte valt och inget undertecknat kontrakt: rapporten säger Avtal saknas, och granskningen varnar", async () => {
    const id = await create(f.a.storeId);
    const snap = await snapshotOf(owner, id);
    expect(snap.report.basis).toMatchObject({ agreementForm: null, contract: null });
    expect(agreementLine(snap.report.basis!, snap.store.name, snap.report.compensation)).toBeNull();
    expect(agreementText(snap.report.basis!, snap.store.name, snap.report.compensation)).toBe(
      "Avtal saknas i underlaget.",
    );
    expect((await archiveRow(id)).agreementMissing).toBe(true);
    // Godkännandet låses inte av det.
    expect(await staleDraftFor(owner, id)).toBeNull();
  });

  it("muntligt avtal går före ett kontrakt som står som undertecknat", async () => {
    // Kontraktsraden som inte är verklig: registrerad för hand räknas som undertecknad.
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.contracts (organization_id, store_id, valid_from, title)
                     values (${f.a.orgId}, ${f.a.storeId}, '2025-01-01', 'Placeringsavtal')`),
    );
    const written = await create(f.a.storeId);
    const before = await snapshotOf(owner, written);
    // Inte valt + undertecknat kontrakt = skriftligt, som förut.
    expect(before.report.basis).toMatchObject({
      agreementForm: null,
      contract: { title: "Placeringsavtal", validFrom: "2025-01-01", signedOn: null },
    });
    expect((await archiveRow(written)).agreementMissing).toBeUndefined();

    expect(await setStoreAgreementFormFor(owner, { storeId: f.a.storeId, form: "oral" })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await formOf(f.a.storeId)).toBe("oral");
    expect(await staleDraftFor(owner, written)).not.toBeNull();

    const oral = await create(f.a.storeId);
    const snap = await snapshotOf(owner, oral);
    expect(snap.report.basis).toMatchObject({ agreementForm: "oral", contract: null });
    // Villkoren i klartext: butikens avtal är provision 20 %.
    expect(snap.report.compensation.termsText?.replace(/ /g, " ")).toBe(
      "provision 20 % på kundernas betalning",
    );
    expect(
      agreementLine(snap.report.basis!, snap.store.name, snap.report.compensation)?.replace(
        / /g,
        " ",
      ),
    ).toBe(
      "Muntligt avtal mellan Kortautomater i Norden AB och ICA Testbutik: provision 20 % på kundernas betalning.",
    );
    expect((await archiveRow(oral)).agreementMissing).toBeUndefined();
    // Läsaren ser samma förhandsvisning.
    const preview = await previewReportFor(reader, {
      type: "butik",
      month: MONTH,
      storeId: f.a.storeId,
    });
    expect(preview.type === "butik" && preview.report.basis).toEqual(snap.report.basis);
  });

  it("skriftligt avtal valt: skriftligt, kontraktet, parterna och villkoren", async () => {
    await setStoreAgreementFormFor(owner, { storeId: f.a.storeId, form: "written" });
    const withContract = await snapshotOf(owner, await create(f.a.storeId));
    expect(
      agreementLine(
        withContract.report.basis!,
        withContract.store.name,
        withContract.report.compensation,
      )?.replace(/ /g, " "),
    ).toBe(
      `Skriftligt avtal (Placeringsavtal) mellan Kortautomater i Norden AB och ICA Testbutik från 1 januari 2025: ${withContract.report.compensation.termsText?.replace(/ /g, " ")}.`,
    );
    // Den andra butiken har inget kontrakt i appen: ägarens val gäller, utan namn och datum.
    await setStoreAgreementFormFor(owner, { storeId: f.a2.storeId, form: "written" });
    const id = await create(f.a2.storeId);
    const snap = await snapshotOf(owner, id);
    expect(snap.report.basis?.contract).toBeNull();
    expect(agreementLine(snap.report.basis!, snap.store.name, snap.report.compensation)).toMatch(
      /^Skriftligt avtal mellan Kortautomater i Norden AB och /,
    );
    await setStoreAgreementFormFor(owner, { storeId: f.a2.storeId, form: null });
    await setStoreAgreementFormFor(owner, { storeId: f.a.storeId, form: "oral" });
  });
});

describe("redan betalt", () => {
  let approved: string;
  let settlementId: string;

  it("ingen betald avräkning: inga betalningar, fakturablocket som förut", async () => {
    // En obetald avräkning räknas inte.
    settlementId = (
      await asPostgres((tx) =>
        one<{ id: string }>(
          tx,
          sql`insert into public.store_settlements
                (organization_id, store_id, month, amount_ore, statement, calc_version)
              values (${f.a.orgId}, ${f.a.storeId}, '2025-03-01', 3360, '{}'::jsonb, 'test')
              returning id`,
        ),
      )
    ).id;
    approved = await create(f.a.storeId);
    const snap = await snapshotOf(owner, approved);
    expect(snap.report.basis?.payments).toEqual([]);
    // 79 kr + 89 kr, provision 20 % = 33,60 kr, moms 8,40 kr.
    expect(snap.report.compensation.totalOre).toBe(3_360);
    expect(invoiceRows(snap.report.basis!, snap.report).map((r) => [r.key, r.amountOre])).toEqual([
      ["amount", 3_360],
      ["vat", 840],
      ["total", 4_200],
    ]);
    await approveReportFor(owner, approved, null);
  });

  it("avräkningen betalas: nästa rapport visar Redan betalt och Kvar att betala", async () => {
    const draft = await create(f.a.storeId);
    const paid = await markSettlementPaidFor(owner, settlementId, "2025-04-05");
    expect(paid.amountOre).toBe(3_360);
    // Avräkningen är orörd av rapporten: samma belopp och betaldag.
    expect(await staleDraftFor(owner, draft)).not.toBeNull();

    const id = await create(f.a.storeId);
    const snap = await snapshotOf(owner, id);
    expect(snap.report.basis?.payments).toEqual([
      { paidOn: "2025-04-05", amountOre: 3_360, month: "2025-03" },
    ]);
    expect(invoiceRows(snap.report.basis!, snap.report).map((r) => [r.label, r.amountOre])).toEqual(
      [
        ["Ersättning exkl. moms", 3_360],
        ["Moms 25 %", 840],
        ["Att fakturera", 4_200],
        ["Redan betalt 5 apr. 2025 (avräkning mars 2025)", 3_360],
        ["Kvar att betala", 840],
      ],
    );
    const row = await asPostgres((tx) =>
      one<{ amount: string; paid: string }>(
        tx,
        sql`select amount_ore::text as amount, paid_on::text as paid
              from public.store_settlements where id = ${settlementId}`,
      ),
    );
    expect(row).toEqual({ amount: "3360", paid: "2025-04-05" });
  });

  it("en godkänd rapport ändras inte av betalningen", async () => {
    expect((await basisOf(owner, approved))?.payments).toEqual([]);
  });

  it("andra månader och andra butikers betalningar räknas inte", async () => {
    await asPostgres(async (tx) => {
      // Februari för samma butik, och mars för den andra butiken: båda betalda.
      await tx.execute(
        sql`insert into public.store_settlements
              (organization_id, store_id, month, amount_ore, statement, calc_version)
            values (${f.a.orgId}, ${f.a.storeId}, '2025-02-01', 111, '{}'::jsonb, 'test'),
                   (${f.a.orgId}, ${f.a2.storeId}, '2025-03-01', 222, '{}'::jsonb, 'test')`,
      );
      await tx.execute(
        sql`update public.store_settlements set paid_on = '2025-04-06'
             where organization_id = ${f.a.orgId} and amount_ore in (111, 222)`,
      );
    });
    const mine = await previewReportFor(owner, {
      type: "butik",
      month: MONTH,
      storeId: f.a.storeId,
    });
    expect(mine.type === "butik" && mine.report.basis?.payments).toEqual([
      { paidOn: "2025-04-05", amountOre: 3_360, month: "2025-03" },
    ]);
    const other = await previewReportFor(owner, {
      type: "butik",
      month: MONTH,
      storeId: f.a2.storeId,
    });
    expect(other.type === "butik" && other.report.basis?.payments).toEqual([
      { paidOn: "2025-04-06", amountOre: 222, month: "2025-03" },
    ]);
  });
});

describe("hela rapporten och butiksportalen", () => {
  it("allt sparas i rapporten, och portalen får samma rapport för sin egen butik", async () => {
    const id = await create(f.a.storeId);
    await approveReportFor(owner, id, null);
    const snap = await snapshotOf(owner, id);
    expect(snap.report.basis).toEqual({
      rev: 2,
      payer: {
        name: "Kortautomater i Norden AB",
        legal: true,
        orgNumber: "559000-1234",
        address: "Storgatan 1, 111 22 Stockholm",
        vatNumber: "SE559000123401",
        // Organisationen heter något annat i appen.
        brand: owner.organization.name,
        ownsMachines: false,
      },
      recipientAddress: snap.report.basis?.recipientAddress ?? null,
      agreementForm: "oral",
      contract: null,
      vatMode: "added",
      vatRateBp: 2500,
      vmb: true,
      payments: [{ paidOn: "2025-04-05", amountOre: 3_360, month: "2025-03" }],
    } satisfies StoreBasis);
    const portal = await asUser(f.storeA1, (tx) => queryPortalReport(tx, f.a.storeId, id));
    expect((portal.report as { basis?: StoreBasis }).basis).toEqual(snap.report.basis);
    // En annan butiks användare når den inte.
    for (const [u, storeId] of [
      [f.storeA2, f.a2.storeId],
      [f.storeB1, f.b.storeId],
      [f.storeA2, f.a.storeId],
    ] as const) {
      const outcome = await settle(asUser(u, (tx) => queryPortalReport(tx, storeId, id)));
      expect(outcome.ok).toBe(false);
    }

    // Efteråt: inställningarna ändras, den godkända rapporten står kvar.
    await updateCompanyDetailsFor(owner.user, {
      organizationId: f.a.orgId,
      ...COMPANY,
      reportVmb: false,
    });
    await setStoreAgreementFormFor(owner, { storeId: f.a.storeId, form: null });
    expect(await basisOf(owner, id)).toEqual(snap.report.basis);
  });
});

describe("Vi äger och driver automaterna i butikerna", () => {
  it("standard av; ägaren slår på och nästa rapport säger det, en godkänd rapport ändras inte", async () => {
    expect((await stored(f.a.orgId)).reportOwnsMachines).toBe(false);
    const before = await create(f.a.storeId);
    await approveReportFor(owner, before, null);
    expect((await basisOf(owner, before))?.payer.ownsMachines).toBe(false);
    const saved = await updateCompanyDetailsFor(owner.user, {
      organizationId: f.a.orgId,
      ...COMPANY,
      reportOwnsMachines: true,
    });
    expect(saved).toEqual({ ok: true, data: { changed: true } });
    expect((await stored(f.a.orgId)).reportOwnsMachines).toBe(true);
    const next = await create(f.a.storeId);
    expect((await basisOf(owner, next))?.payer.ownsMachines).toBe(true);
    expect((await basisOf(owner, before))?.payer.ownsMachines).toBe(false);
  });

  it("läsare och butiksanvändare får inte ändra (RLS)", async () => {
    for (const u of [f.viewerA, f.storeA1, f.b.owner]) {
      const outcome = await settle(
        asUser(u, (tx) =>
          affected(
            tx,
            sql`update public.organization_settings set report_owns_machines = false
                where organization_id = ${f.a.orgId}::uuid`,
          ),
        ),
      );
      if (outcome.ok) expect(outcome.value).toBe(0);
      else expect(outcome.code).toBe("42501");
    }
    expect((await stored(f.a.orgId)).reportOwnsMachines).toBe(true);
  });

  it("butikens adress står under Mottagare (sparad i rapporten)", async () => {
    await asPostgres((tx) =>
      tx.execute(sql`update public.stores set address = 'Torget 2, 411 01 Göteborg'
                     where id = ${f.a.storeId}`),
    );
    const id = await create(f.a.storeId);
    expect((await basisOf(owner, id))?.recipientAddress).toBe("Torget 2, 411 01 Göteborg");
  });
});
