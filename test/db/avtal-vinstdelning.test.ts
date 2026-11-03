/**
 * Avtal med vinstdelning (migreringarna 20261103230000/20261103230100) mot testdatabasen:
 * nya avtal från Butiker blir 50 % av vinsten efter kostnader, äldre anrop utan modell
 * blir andel av försäljningen, en vinstdelning kräver en andel, förlusthanteringen har
 * standardvärdet 'zero', portalen får underlaget, och butiksrapporten räknar vinsten med
 * VMB-moms och inköp, eller stoppas med en rad när ett inköpspris saknas.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createAgreementFor,
  updateAgreementFor,
  type Viewer as StoreViewer,
} from "@/app/(app)/butiker/_lib/service";
import * as s from "@/db/schema";
import { MISSING_PRICES_MESSAGE } from "@/reports";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import { previewReportFor, ReportError, type Viewer } from "@/server/reports/service";

import {
  asUser,
  attempt,
  createOrg,
  createUser,
  db,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const NOW = new Date("2025-11-05T09:00:00Z");

let owner: TestUser;
let orgId: string;
let viewer: Viewer;
let storeId: string;
let titlePriced: string;
let titleUnpriced: string;

async function viewerFor(u: TestUser): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

beforeAll(async () => {
  owner = await createUser(`vinstdelning-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Vinstdelning ${uniqueSuffix()}`);
  viewer = await viewerFor(owner);
  await asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Sega gubben" })
      .returning();
    storeId = store!.id;
    const [m] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Entré", activeFrom: "2025-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: m!.id, storeId, validFrom: "2025-01-01" });
    const [t1, t2] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Mystery Pack" },
        { ...org, name: "Mystery Pack Premium" },
      ])
      .returning();
    titlePriced = t1!.id;
    titleUnpriced = t2!.id;
    await tx
      .insert(s.purchasePrices)
      .values({ ...org, titleId: titlePriced, unitCostOre: 13_000, validFrom: "2025-01-01" });
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish" })
      .returning();
    const order = (ext: string, at: string, titleId: string, amountOre: number) => ({
      ...org,
      dataSourceId: source!.id,
      externalId: ext,
      rawTitle: "x",
      titleId,
      orderedAt: new Date(at),
      amountOre,
      machineId: m!.id,
      sourceHash: `h${ext}`,
    });
    await tx
      .insert(s.orders)
      .values([
        order("1", "2025-09-10T10:00:00Z", titlePriced, 19_900),
        order("2", "2025-09-11T10:00:00Z", titleUnpriced, 24_900),
        order("3", "2025-10-03T10:00:00Z", titlePriced, 19_900),
        order("4", "2025-10-04T10:00:00Z", titlePriced, 19_900),
      ]);
  });
  // Avtalet: vinstdelning 50/50 från 1 sep. 2025, skapat som i formuläret.
  const r = await createAgreementFor(
    viewer as StoreViewer,
    { storeId, validFrom: "2025-09-01", model: "split", confirmHistory: true },
    "2025-11-05",
  );
  if (!r.ok) throw new Error(r.error);
});

describe("avtal med vinstdelning", () => {
  it("formulärets standardval sparar 50 % av vinsten efter kostnader, förlust ger 0", async () => {
    const [a] = await rows<{
      commission_base: string;
      commission_bp: number;
      loss_treatment: string;
      vmb_before_split: boolean;
    }>(
      db(),
      sql`select commission_base::text, commission_bp, loss_treatment::text, vmb_before_split
          from public.store_agreements where store_id = ${storeId}`,
    );
    expect(a).toEqual({
      commission_base: "profit_after_costs",
      commission_bp: 5_000,
      loss_treatment: "zero",
      vmb_before_split: false,
    });
  });

  it("anrop utan modell blir andel av försäljningen (som förut)", async () => {
    const other = await asUser(owner, async (tx) => {
      const [x] = await tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: `Annan ${uniqueSuffix()}` })
        .returning();
      return x!.id;
    });
    const r = await createAgreementFor(
      viewer as StoreViewer,
      { storeId: other, validFrom: "2025-12-01", commission: "12" },
      "2025-11-05",
    );
    expect(r.ok).toBe(true);
    const [a] = await rows<{ commission_base: string; commission_bp: number }>(
      db(),
      sql`select commission_base::text, commission_bp from public.store_agreements
          where store_id = ${other}`,
    );
    expect(a).toEqual({ commission_base: "net_excl_vat", commission_bp: 1_200 });
  });

  it("en vinstdelning utan andel nekas av databasen", async () => {
    const outcome = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into public.store_agreements
            (organization_id, store_id, valid_from, commission_base, monthly_rent_ore)
          values (${orgId}, ${storeId}, '2030-01-01', 'profit_after_costs', 1000)`),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("23514");
  });

  it("byte från vinstdelning till andel av försäljning räknas som ändrade villkor", async () => {
    const [a] = await rows<{ id: string }>(
      db(),
      sql`select id from public.store_agreements where store_id = ${storeId}`,
    );
    const r = await updateAgreementFor(
      viewer as StoreViewer,
      { agreementId: a!.id, model: "sales", commission: "50" },
      "2025-11-05",
    );
    // Passerade dagar räknas om: kräver bekräftelse.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.needsConfirm).toBe(true);
  });

  it("portal_agreements returnerar underlag och förlusthantering", async () => {
    const cols = await rows<{ name: string }>(
      db(),
      sql`select unnest(proargnames) as name from pg_proc
          where proname = 'portal_agreements' and pronamespace = 'public'::regnamespace`,
    );
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(["commission_base", "loss_treatment"]),
    );
  });
});

describe("butiksrapporten med vinstdelning", () => {
  it("oktober, standard utan VMB-avdrag: butikens andel = 50 % × vinst efter kostnader", async () => {
    const snap = await previewReportFor(viewer, { type: "butik", month: "2025-10", storeId }, NOW);
    if (snap.type !== "butik") throw new Error("fel typ");
    const c = snap.report.compensation;
    expect(c.model).toBe("profit_split");
    // 398 kr sålt, 260 kr inköp: vinst 138 kr (ingen VMB-moms före delningen), butiken 69 kr.
    const x = c.splits[0]!;
    expect(x).toMatchObject({
      salesInclVatOre: 39_800,
      vmbVatOre: 0,
      vmbBeforeSplit: false,
      purchasesOre: 26_000,
      profitOre: 13_800,
      storeShareOre: 6_900,
    });
    expect(x.storeShareOre).toBe(
      Math.round(
        (x.shareBp * (x.salesInclVatOre - (x.refundsOre ?? 0) - x.purchasesOre - x.cardFeesOre)) /
          10_000,
      ),
    );
    expect(c.totalOre).toBe(6_900);
  });

  it("oktober med avtalets val på: VMB-moms dras före delningen", async () => {
    await db().execute(
      sql`update public.store_agreements set vmb_before_split = true where store_id = ${storeId}`,
    );
    try {
      const snap = await previewReportFor(
        viewer,
        { type: "butik", month: "2025-10", storeId },
        NOW,
      );
      if (snap.type !== "butik") throw new Error("fel typ");
      // Marginal 138 kr, VMB 27,60 kr, vinst 110,40 kr, butiken 55,20 kr.
      expect(snap.report.compensation.splits[0]).toMatchObject({
        vmbVatOre: 2_760,
        profitOre: 11_040,
        storeShareOre: 5_520,
      });
    } finally {
      await db().execute(
        sql`update public.store_agreements set vmb_before_split = false where store_id = ${storeId}`,
      );
    }
  });

  it("september: ett pack saknar inköpspris, rapporten stoppas med en rad", async () => {
    const error = await previewReportFor(
      viewer,
      { type: "butik", month: "2025-09", storeId },
      NOW,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReportError);
    const message = (error as ReportError).message;
    expect(message.startsWith(MISSING_PRICES_MESSAGE)).toBe(true);
    expect(message).toContain("Mystery Pack Premium");
    expect(message).not.toContain("\n");
  });
});
