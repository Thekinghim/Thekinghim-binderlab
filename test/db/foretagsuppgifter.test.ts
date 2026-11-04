/**
 * Företagsuppgifter och kontraktens luckor (20261106050000_foretagsuppgifter.sql,
 * Inställningar → Företaget, src/server/contracts) mot testdatabasen:
 *  - våra uppgifter (adress, kontakt, e-post, telefon) sparas och står i kontraktet
 *    (förut bara namn och org.nr, resten blev tomma rader),
 *  - organisationsnumret är detsamma i Bokföring och kontrakten,
 *  - Skapa kontrakt föreslår butikens första dag i stället för i dag (Sega gubben sålde
 *    från 14 okt. men kontraktet gällde från 3 nov.),
 *  - Kontrakt → Intäkt räknar intäkt bakom ett osignerat kontrakt som "utan signerat
 *    kontrakt" (förut "0,0 % i riskzonen" fast inget var signerat).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { updateCompanyDetailsFor } from "@/app/(app)/installningar/_lib/data";
import * as s from "@/db/schema";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import { loadContractsFor } from "@/server/accounting";
import {
  contractTemplateHtmlFor,
  createStoreContractFor,
  loadContractSetupFor,
  loadStoreSalesFor,
  setContractStatusFor,
  type Viewer,
} from "@/server/contracts";
import { operatorGaps } from "@/server/contracts/operator";

import {
  asPostgres,
  asUser,
  createMember,
  createOrg,
  createUser,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const TODAY = "2026-11-03";
const PDF = new TextEncoder().encode("%PDF-1.4\n% test\n");

let owner: TestUser;
let orgId: string;
let viewer: Viewer;
let files: LocalFileStore;
let storeId: string;

const flat = (t: string) => t.replace(/\s+/g, " ");
const user = (u: TestUser): SessionUser => ({ userId: u.id, email: u.email });

const COMPANY = {
  companyName: "Binderlab AB",
  orgNumber: "5590001234",
  companyAddress: "Storgatan 1, 111 22 Stockholm",
  contactName: "Wille Test",
  contactEmail: "hej@binderlab.se",
  contactPhone: "070-123 45 67",
};

beforeAll(async () => {
  owner = await createUser(`foretag-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Företag ${uniqueSuffix()}`);
  const organization = (await listOrganizationsFor(user(owner))).find((o) => o.id === orgId)!;
  viewer = { user: user(owner), organization };
  files = new LocalFileStore(mkdtempSync(path.join(tmpdir(), "foretag-")));
  // Sega gubben: automat från 14 okt., villkor från 14 okt., order 14 okt. – 2 nov.
  // och ett testköp 10 okt. (räknas inte).
  storeId = await asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Sega gubben" })
      .returning();
    await tx.insert(s.storeAgreements).values({
      ...org,
      storeId: store!.id,
      validFrom: "2026-10-14",
      commissionBp: 5_000,
      commissionBase: "profit_after_costs",
    });
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2026-10-10" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2026-10-10" });
    const [title] = await tx
      .insert(s.titles)
      .values({ ...org, name: "Mystery Pack" })
      .returning();
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const base = {
      ...org,
      dataSourceId: source!.id,
      machineId: machine!.id,
      titleId: title!.id,
      rawTitle: "Mystery Pack",
      paymentMethod: "card",
      amountOre: 10_000,
    };
    await tx.insert(s.orders).values([
      { ...base, externalId: "t", orderedAt: new Date("2026-10-10T10:00:00Z"), sourceHash: "t" },
      { ...base, externalId: "1", orderedAt: new Date("2026-10-14T10:00:00Z"), sourceHash: "1" },
      { ...base, externalId: "2", orderedAt: new Date("2026-11-02T10:00:00Z"), sourceHash: "2" },
    ]);
    return store!.id;
  });
  await asPostgres((tx) =>
    tx.execute(
      sql`update public.orders set test_purchase_at = now()
          where organization_id = ${orgId}::uuid and external_id = 't'`,
    ),
  );
});

describe("Inställningar → Företaget", () => {
  it("sparar uppgifterna; kontraktet har adress, kontakt, e-post och telefon", async () => {
    const before = await loadContractSetupFor(viewer, TODAY);
    expect(operatorGaps(before.operator)).toEqual([
      "org.nr",
      "adress",
      "kontaktperson",
      "e-post",
      "telefon",
    ]);

    const r = await updateCompanyDetailsFor(user(owner), { organizationId: orgId, ...COMPANY });
    expect(r).toEqual({ ok: true, data: { changed: true } });
    // Samma värden igen: inget att spara.
    expect(
      await updateCompanyDetailsFor(user(owner), {
        organizationId: orgId,
        ...COMPANY,
        orgNumber: "559000-1234",
      }),
    ).toEqual({ ok: true, data: { changed: false } });

    const setup = await loadContractSetupFor(viewer, TODAY);
    expect(setup.operator).toEqual({
      name: "Binderlab AB",
      orgNumber: "559000-1234",
      address: "Storgatan 1, 111 22 Stockholm",
      contactName: "Wille Test",
      email: "hej@binderlab.se",
      phone: "070-123 45 67",
    });
    expect(setup.operatorGaps).toEqual([]);
    expect(setup.orgNumberMissing).toBe(false);

    const rendered: string[] = [];
    const res = await createStoreContractFor(
      viewer,
      { target: `store:${storeId}`, validFrom: "2026-10-14", confirmHistory: true },
      {
        today: TODAY,
        renderPdf: async (html) => {
          rendered.push(html);
          return PDF;
        },
        fileStore: files,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const html of [rendered[0]!, await contractTemplateHtmlFor(viewer, res.contractId)]) {
      const block = flat(html).slice(
        flat(html).indexOf("Operatören"),
        flat(html).indexOf("Butiken</div>"),
      );
      expect(block).toContain("Binderlab AB");
      expect(block).toContain("559000-1234");
      expect(block).toContain("Storgatan 1, 111 22 Stockholm");
      expect(block).toContain("Wille Test");
      expect(block).toContain("hej@binderlab.se");
      expect(block).toContain("070-123 45 67");
      expect(block).not.toContain("____");
    }
  });

  it("organisationsnumret är detsamma i Bokföring och i kontrakten", async () => {
    await asUser(owner, (tx) =>
      tx.execute(sql`
        insert into public.bookkeeping_settings
          (organization_id, account_plan, voucher_series, org_number, purchase_basis, opening_carry_ore)
        values (${orgId}::uuid, '{}'::jsonb, 'BL', '559000-1234', 'cost_of_goods', 0)`),
    );
    const r = await updateCompanyDetailsFor(user(owner), {
      organizationId: orgId,
      ...COMPANY,
      orgNumber: "559000-9999",
    });
    expect(r.ok).toBe(true);
    const [bk] = await asUser(owner, (tx) =>
      tx.select({ orgNumber: s.bookkeepingSettings.orgNumber }).from(s.bookkeepingSettings),
    );
    expect(bk!.orgNumber).toBe("559000-9999");
    expect((await loadContractSetupFor(viewer, TODAY)).operator.orgNumber).toBe("559000-9999");
  });

  it("fel organisationsnummer eller e-post och läsare nekas", async () => {
    expect(
      await updateCompanyDetailsFor(user(owner), {
        organizationId: orgId,
        ...COMPANY,
        orgNumber: "12",
      }),
    ).toEqual({ ok: false, error: "Organisationsnummer skrivs NNNNNN-NNNN." });
    expect(
      await updateCompanyDetailsFor(user(owner), {
        organizationId: orgId,
        ...COMPANY,
        contactEmail: "inte-en-adress",
      }),
    ).toEqual({ ok: false, error: "E-postadressen ser inte rätt ut." });
    const reader = await createMember(orgId, "viewer");
    const denied = await updateCompanyDetailsFor(user(reader), {
      organizationId: orgId,
      ...COMPANY,
      contactName: "Läsaren",
    });
    expect(denied.ok).toBe(false);
  });
});

describe("Skapa kontrakt: startdagen täcker försäljningen", () => {
  it("föreslår villkorens start (14 okt.), inte i dag; första försäljningen utan testköp", async () => {
    const other = await createUser(`foretag-b-${uniqueSuffix()}@test.binderlab.se`);
    const otherOrg = await createOrg(other, `Företag B ${uniqueSuffix()}`);
    const organization = (await listOrganizationsFor(user(other))).find((o) => o.id === otherOrg)!;
    const v: Viewer = { user: user(other), organization };
    const id = await asUser(other, async (tx) => {
      const org = { organizationId: otherOrg };
      const [store] = await tx
        .insert(s.stores)
        .values({ ...org, name: "Kiosken" })
        .returning();
      await tx
        .insert(s.storeAgreements)
        .values({ ...org, storeId: store!.id, validFrom: "2026-10-14", commissionBp: 1_000 });
      return store!.id;
    });
    const setup = await loadContractSetupFor(v, TODAY);
    const option = setup.options.find((o) => o.value === `store:${id}`)!;
    expect(option.suggestedFrom).toBe("2026-10-14");

    // Sega gubben (ovan): automat från 10 okt., första riktiga försäljningen 14 okt.
    const sales = await loadStoreSalesFor(viewer);
    expect(sales.get(storeId)).toEqual({
      firstSale: "2026-10-14",
      lastSale: "2026-11-02",
      firstPlacement: "2026-10-10",
    });
  });
});

describe("Kontrakt → Intäkt", () => {
  it("intäkt bakom ett skickat men osignerat kontrakt räknas som utan signerat kontrakt", async () => {
    const view = await loadContractsFor(viewer, TODAY);
    const contract = view.contracts.find((c) => c.storeId === storeId && c.template !== null)!;
    await setContractStatusFor(viewer, { id: contract.id, status: "sent" });
    const sent = await loadContractsFor(viewer, TODAY);
    const o = sent.overview!;
    expect(o.totalRevenueOre).toBeGreaterThan(0);
    expect(o.noContractRevenueOre).toBe(o.totalRevenueOre);
    expect(o.stores.find((r) => r.storeId === storeId)?.category).toBe("no-contract");

    await setContractStatusFor(viewer, { id: contract.id, status: "signed" });
    const signed = (await loadContractsFor(viewer, TODAY)).overview!;
    expect(signed.noContractRevenueOre).toBe(0);
    expect(signed.stores.find((r) => r.storeId === storeId)?.category).toBe("secure");

    // Utan översikten (fliken Kontrakt): ingen tung fråga och ingen översikt.
    expect((await loadContractsFor(viewer, TODAY, { overview: false })).overview).toBeNull();
  });
});
