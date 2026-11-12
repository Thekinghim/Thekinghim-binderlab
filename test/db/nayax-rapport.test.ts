/**
 * Nayax månadsrapport (PDF) mot testdatabasen: rapporten läses och sparas som en utbetalning
 * med rapportens egna avgifter, engångsavgiften är ett känt avdrag (ingen avvikelse),
 * samma rapport två gånger ger ingen ny rad, dagar som redan har en utbetalning nekas (en
 * inskriven går att ersätta), och kortavgiften ändras bara när ägaren ber om det. Bara ägare
 * och admin, och bara i den egna organisationen.
 *
 * Rapporten är ./src/server/accounting/testing: riktiga belopp, påhittat företag.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { updateSettingsFor } from "@/app/(app)/installningar/_lib/data";
import * as s from "@/db/schema";
import type { FileStore } from "@/import/file-store";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import {
  AccountingError,
  addManualPayoutFor,
  archivePayoutFor,
  importNayaxStatementFor,
  importPayoutFileFor,
  loadReconciliationFor,
  statementCardFeeFor,
  type NayaxUploadResult,
} from "@/server/accounting/service";
import { NAYAX_OCTOBER } from "@/server/accounting/testing/nayax-fixture";
import { buildPdf, editLines, octoberPdf } from "@/server/accounting/testing/nayax-pdf";
import type { Viewer } from "@/server/data/core/loaders";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const OCTOBER = { start: "2026-10-01", end: "2026-10-31" };
const TODAY = "2026-11-12";

let orgId: string;
let ownerUser: TestUser;
let owner: Viewer;
let admin: Viewer;
let reader: Viewer;
let refiller: Viewer;
let outsider: Viewer;
let outsiderUser: TestUser;
let otherOrgId: string;

const stored: string[] = [];
const files: FileStore = {
  kind: "local",
  async put(path) {
    stored.push(path);
    return { path, created: true };
  },
  async get() {
    return new Uint8Array();
  },
};
const upload = (viewer: Viewer, bytes: Uint8Array, replaceManualId?: string) =>
  importNayaxStatementFor(
    viewer,
    { name: "Reimbursement Statement.pdf", bytes },
    { fileStore: files, replaceManualId },
  );

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const payoutRows = (org = orgId) =>
  rows<{
    id: string;
    reference: string;
    amount_ore: string;
    fees_ore: string;
    manual: boolean;
    paid_on: string | null;
    archived: boolean;
    note: string | null;
    has_statement: boolean;
    has_import: boolean;
  }>(
    db(),
    sql`select id, reference, amount_ore::text, fees_ore::text, manual, paid_on::text,
               archived_at is not null as archived, note, statement is not null as has_statement,
               import_id is not null as has_import
        from public.payouts where organization_id = ${org}::uuid order by created_at`,
  );
const importCount = async () =>
  (
    await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.payout_imports where organization_id = ${orgId}::uuid`,
    )
  )[0]!.n;
const active = async () => (await payoutRows()).filter((p) => !p.archived);

beforeAll(async () => {
  ownerUser = await createUser(`nayax-agare-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(ownerUser, `Nayax ${uniqueSuffix()}`);
  owner = await viewerFor(ownerUser, orgId);
  admin = await viewerFor(await createMember(orgId, "admin"), orgId);
  reader = await viewerFor(await createMember(orgId, "viewer"), orgId);
  refiller = await viewerFor(await createMember(orgId, "refiller"), orgId);
  outsiderUser = await createUser(`nayax-annan-${uniqueSuffix()}@test.binderlab.se`);
  otherOrgId = await createOrg(outsiderUser, `Annan ${uniqueSuffix()}`);
  outsider = await viewerFor(outsiderUser, otherOrgId);
  await asUser(ownerUser, async (tx) => {
    const org = { organizationId: orgId };
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Sega Gubben", activeFrom: "2026-01-01" })
      .returning();
    const [title] = await tx
      .insert(s.titles)
      .values({ ...org, name: "Pokémon 151" })
      .returning();
    await tx
      .insert(s.purchasePrices)
      .values({ ...org, titleId: title!.id, unitCostOre: 2000, validFrom: "2026-01-01" });
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const [sourceMachine] = await tx
      .insert(s.sourceMachines)
      .values({
        ...org,
        dataSourceId: source!.id,
        externalId: "AW-1",
        externalName: "Order Machine 1",
        machineId: machine!.id,
      })
      .returning();
    const [imp] = await tx
      .insert(s.imports)
      .values({
        ...org,
        dataSourceId: source!.id,
        trigger: "upload",
        fileName: "orders.csv",
        fileSha256: "d".repeat(64),
        storagePath: `${orgId}/imports/orders.csv`,
        parserVersion: "awish-csv@1",
        status: "succeeded",
      })
      .returning();
    // Oktober: tre order som summerar till rapportens försäljning, 76 245,00 kr. Med 4 %
    // kortavgift per order: 2 900,44 + 148,00 + 1,36 = 3 049,80 kr, som i rapporten.
    const amounts = [7_251_100, 370_000, 3_400];
    await tx.insert(s.orders).values(
      amounts.map((amountOre, i) => ({
        ...org,
        dataSourceId: source!.id,
        rawTitle: "Pokemon 151",
        titleId: title!.id,
        amountOre,
        sourceMachineId: sourceMachine!.id,
        machineId: machine!.id,
        importId: imp!.id,
        externalId: String(90001 + i),
        orderedAt: new Date(`2026-10-${String(i + 5).padStart(2, "0")}T10:00:00Z`),
        sourceHash: `nayax-${i}`,
      })),
    );
  });
});

describe("vem som får ladda upp", () => {
  it("läsaren och påfyllaren nekas, och inget sparas", async () => {
    for (const v of [reader, refiller]) {
      await expect(upload(v, octoberPdf())).rejects.toBeInstanceOf(AuthorizationError);
    }
    expect(await payoutRows()).toEqual([]);
    expect(stored).toEqual([]);
  });

  it("en ägare i en annan organisation kommer inte åt den här", async () => {
    const forged: Viewer = { user: outsider.user, organization: owner.organization };
    await expect(upload(forged, octoberPdf())).rejects.toBeInstanceOf(AuthorizationError);
    expect(await payoutRows()).toEqual([]);
    expect(stored).toEqual([]);
  });

  it("en fil som inte är en rapport från Nayax sparar ingenting", async () => {
    const invoice = buildPdf([[1, -800, [[40, 120, "Faktura 1234"]]]]);
    await expect(upload(owner, invoice)).rejects.toThrow(/inte en utbetalningsrapport från Nayax/);
    await expect(upload(owner, octoberPdf().slice(0, 500))).rejects.toBeInstanceOf(AccountingError);
    const wrongSum = buildPdf(
      editLines(NAYAX_OCTOBER, (t) => (t === "kr 72,330.48" ? "kr 99,330.48" : undefined)),
    );
    await expect(upload(owner, wrongSum)).rejects.toThrow(/summa går inte ihop/);
    expect(await payoutRows()).toEqual([]);
    expect(await importCount()).toBe(0);
    expect(stored).toEqual([]);
  });
});

describe("rapporten sparas som en utbetalning", () => {
  let saved: NayaxUploadResult;

  it("beloppet som kommer in, rapportens avgifter och utbetalningsdagen", async () => {
    const res = await upload(admin, octoberPdf());
    if (res.status === "manual_clash") throw new Error("oväntat");
    saved = res;
    expect(res).toMatchObject({
      status: "saved",
      reference: "Nayax 2026-10",
      period: OCTOBER,
      appSalesOre: 7_624_500,
      appOrders: 3,
      salesDifferenceOre: 0,
      statementCardFeeBp: 400,
      settingCardFeeBp: 0,
      replaced: null,
    });
    expect(await payoutRows()).toEqual([
      {
        id: res.payoutId,
        reference: "Nayax 2026-10",
        amount_ore: "7233048",
        fees_ore: "308980",
        manual: false,
        paid_on: "2026-11-16",
        archived: false,
        note: null,
        has_statement: true,
        has_import: true,
      },
    ]);
    expect(await importCount()).toBe(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(new RegExp(`^${orgId}/payouts/[0-9a-f]{64}\\.pdf$`));
  });

  it("företagets namn, kundnummer och e-post sparas inte i raden", async () => {
    const [row] = await rows<{ statement: string }>(
      db(),
      sql`select statement::text from public.payouts where id = ${saved.payoutId}::uuid`,
    );
    for (const secret of ["Exempel Automat AB", "1000000001", "C100001", "example.com"]) {
      expect(row!.statement).not.toContain(secret);
    }
    expect(JSON.parse(row!.statement)).toMatchObject({
      provider: "nayax",
      grossOre: 7_624_500,
      cardFeeOre: 304_980,
      totalOre: 7_233_048,
    });
  });

  it("avstämningen: engångsavgiften är ingen avvikelse, bara kortavgiften (inställningen är 0 %)", async () => {
    const rec = await loadReconciliationFor(owner, OCTOBER);
    const p = rec.result!.payouts[0]!;
    // Väntat = försäljning 76 245,00 − kortavgift 0 − kända avdrag 864,72 (40,00 + 824,72).
    expect(p.expected).toMatchObject({ salesOre: 7_624_500, feesOre: 0, payoutOre: 7_538_028 });
    expect(p.actual).toMatchObject({
      payoutOre: 7_233_048,
      feesOre: 304_980,
      salesOre: 7_624_500,
    });
    expect(p.deviations.map((d) => [d.kind, d.impactOre])).toEqual([["fee", -304_980]]);
    expect(saved.matches).toBe(false);
    expect(rec.payouts[0]!.statement?.deductions.map((d) => [d.kind, d.amountOre])).toEqual([
      ["bank_fee", 4_000],
      ["adjustment", 82_472],
    ]);
  });

  it("samma rapport en gång till: ingen ny rad, samma kvitto", async () => {
    const again = await upload(owner, octoberPdf());
    expect(again).toMatchObject({ status: "duplicate", payoutId: saved.payoutId });
    expect(await payoutRows()).toHaveLength(1);
    expect(await importCount()).toBe(1);
    expect(stored).toHaveLength(1);
  });

  it("samma dagar med andra belopp nekas: arkivera först", async () => {
    const changed = buildPdf(
      editLines(NAYAX_OCTOBER, (t) =>
        t === "(Payout Until Date: 16/11/2026* )" ? "(Payout Until Date: 17/11/2026* )" : undefined,
      ),
    );
    await expect(upload(owner, changed)).rejects.toThrow(
      /finns redan \(Nayax 2026-10\) med andra belopp\. Arkivera den först/,
    );
    expect(await payoutRows()).toHaveLength(1);
  });

  it("raden går inte att ändra, och en annan organisation ser den inte", async () => {
    const change = await asUser(ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.payouts set statement = '{}'::jsonb where id = ${saved.payoutId}::uuid`,
        ),
      ),
    );
    expect(change.ok).toBe(false);
    const seen = await asUser(outsiderUser, (tx) =>
      rows(tx, sql`select id from public.payouts where id = ${saved.payoutId}::uuid`),
    );
    expect(seen).toEqual([]);
    expect(await payoutRows(otherOrgId)).toEqual([]);
  });
});

describe("kortavgiften", () => {
  it("ändras inte av uppladdningen", async () => {
    expect((await loadReconciliationFor(owner, OCTOBER)).cardFeeBp).toBe(0);
  });

  it("knappen: satsen räknas ur rapporten, bara för ägare och admin", async () => {
    const id = (await active())[0]!.id;
    for (const v of [reader, refiller]) {
      await expect(statementCardFeeFor(v, id)).rejects.toBeInstanceOf(AuthorizationError);
    }
    // En utbetalning i en annan organisation finns inte för den här användaren.
    await expect(statementCardFeeFor(outsider, id)).rejects.toBeInstanceOf(AccountingError);
    const { cardFeeBp, settings } = await statementCardFeeFor(owner, id);
    expect(cardFeeBp).toBe(400);
    // Samma väg som knappen på Ekonomi: inställningarnas egen funktion.
    const denied = await updateSettingsFor(reader.user, {
      organizationId: orgId,
      cardFeeBp,
      vatRateBp: settings.vatRateBp,
      fiscalYearStartMonth: settings.fiscalYearStartMonth,
    });
    expect(denied.ok).toBe(false);
    expect((await loadReconciliationFor(owner, OCTOBER)).cardFeeBp).toBe(0);
    const changed = await updateSettingsFor(owner.user, {
      organizationId: orgId,
      cardFeeBp,
      vatRateBp: settings.vatRateBp,
      fiscalYearStartMonth: settings.fiscalYearStartMonth,
    });
    expect(changed).toEqual({ ok: true, data: { changed: true } });
  });

  it("med 4,0 % stämmer utbetalningen på öret", async () => {
    const rec = await loadReconciliationFor(owner, OCTOBER);
    expect(rec.cardFeeBp).toBe(400);
    const p = rec.result!.payouts[0]!;
    expect(p.expected).toMatchObject({ feesOre: 304_980, payoutOre: 7_233_048 });
    expect(p.differenceOre).toBe(0);
    expect(p.deviations).toEqual([]);
    expect(p.status).toBe("matched");
    const again = await upload(owner, octoberPdf());
    expect(again).toMatchObject({ status: "duplicate", matches: true, settingCardFeeBp: 400 });
  });
});

describe("dagar som redan har en utbetalning", () => {
  it("en inskriven för hand: inget sparas, ägaren får frågan om att ersätta", async () => {
    await archivePayoutFor(owner, { id: (await active())[0]!.id, note: "Test: läses in igen." });
    const manual = await addManualPayoutFor(
      owner,
      { period: OCTOBER, amountOre: 7_233_000, paidOn: "2026-11-10" },
      TODAY,
    );
    const before = stored.length;
    const res = await upload(owner, octoberPdf());
    expect(res).toEqual({
      status: "manual_clash",
      manualId: manual.id,
      manualReference: "Inskriven 2026-10",
      manualAmountOre: 7_233_000,
      period: OCTOBER,
      totalOre: 7_233_048,
    });
    // Ett annat id än den inskrivnas ersätter ingenting.
    const wrong = await upload(owner, octoberPdf(), "00000000-0000-4000-8000-000000000000");
    expect(wrong.status).toBe("manual_clash");
    expect((await active()).map((p) => p.reference)).toEqual(["Inskriven 2026-10"]);
    expect(stored.length).toBe(before);
  });

  it("Ersätt: den inskrivna arkiveras med anteckning och rapporten sparas", async () => {
    const manualId = (await active())[0]!.id;
    const res = await upload(owner, octoberPdf(), manualId);
    expect(res).toMatchObject({ status: "saved", replaced: "Inskriven 2026-10", matches: true });
    const all = await payoutRows();
    expect(all.find((p) => p.id === manualId)).toMatchObject({
      archived: true,
      note: "Ersatt av rapporten från Nayax (Nayax 2026-10).",
    });
    expect((await active()).map((p) => [p.reference, p.amount_ore])).toEqual([
      ["Nayax 2026-10", "7233048"],
    ]);
  });

  it("en utbetalning från en CSV-fil för samma dagar: nekas, och den går inte att ersätta", async () => {
    await archivePayoutFor(owner, { id: (await active())[0]!.id, note: "Test: CSV i stället." });
    const csv = new TextEncoder().encode(
      "Referens;Period från;Period till;Utbetald;Belopp;Avgifter\r\nAW-OKT;2026-10-15;2026-10-31;2026-11-03;1000,00;0\r\n",
    );
    const imported = await importPayoutFileFor(
      owner,
      { name: "utbetalningar.csv", bytes: csv },
      { fileStore: files },
    );
    expect(imported).toMatchObject({ format: "payouts", rowsNew: 1 });
    const csvId = (await active())[0]!.id;
    for (const replace of [undefined, csvId]) {
      await expect(upload(owner, octoberPdf(), replace)).rejects.toThrow(
        /Det finns redan en utbetalning för de dagarna \(AW-OKT\)\. Arkivera den först/,
      );
    }
    expect((await active()).map((p) => p.reference)).toEqual(["AW-OKT"]);
  });
});
