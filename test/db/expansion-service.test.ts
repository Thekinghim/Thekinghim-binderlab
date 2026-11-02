/**
 * Expansion, enhetsekonomi och effekt (src/app/(app)/expansion/_lib/service.ts) mot
 * testdatabasen: platsattribut, investeringar, mål, pipeline, utgångsläge, mätvärden och
 * timkostnad. Behörighet (ägare/admin skriver, läsaren läser, påfyllaren ingenting),
 * isolering mellan organisationer, unika nycklar och ändringslogg.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  deleteBaselineFor,
  deleteGoalFor,
  deleteLeadFor,
  deleteMeasurementFor,
  ExpansionError,
  loadBaselinesFor,
  loadEffectSettingsFor,
  loadGoalsFor,
  loadInvestmentsFor,
  loadLeadsFor,
  loadMeasurementsFor,
  loadStoreProfilesFor,
  saveBaselineFor,
  saveEffectSettingsFor,
  saveGoalFor,
  saveInvestmentFor,
  saveLeadFor,
  saveMeasurementFor,
  saveStoreProfileFor,
  setLeadStageFor,
  type Viewer,
} from "../../src/app/(app)/expansion/_lib/service";
import {
  baselineSchema,
  goalSchema,
  investmentSchema,
  leadSchema,
  measurementSchema,
} from "../../src/app/(app)/expansion/_lib/schemas";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  pgError,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let orgId: string;
let otherOrgId: string;
let owner: Viewer;
let admin: Viewer;
let viewer: Viewer;
let refiller: Viewer;
let otherOwner: Viewer;
let storeId: string;
let machineId: string;

beforeAll(async () => {
  const o = await createUser(`owner-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(o, "Expansion AB");
  owner = await viewerFor(o, orgId);
  admin = await viewerFor(await createMember(orgId, "admin"), orgId);
  viewer = await viewerFor(await createMember(orgId, "viewer"), orgId);
  refiller = await viewerFor(await createMember(orgId, "refiller"), orgId);

  const o2 = await createUser(`owner2-${uniqueSuffix()}@test.binderlab.se`);
  otherOrgId = await createOrg(o2, "Annan AB");
  otherOwner = await viewerFor(o2, otherOrgId);

  const ids = await asUser({ id: o.id, email: o.email }, async (tx) => {
    const store = await one<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name) values (${orgId}, 'Ica Nära') returning id`,
    );
    const machine = await one<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name) values (${orgId}, 'BL-001', 'Automat 1') returning id`,
    );
    return { storeId: store.id, machineId: machine.id };
  });
  storeId = ids.storeId;
  machineId = ids.machineId;
});

describe("platsattribut", () => {
  it("ägaren sätter butikstyp, ort, öppettider och yta; läsaren ser dem", async () => {
    await saveStoreProfileFor(owner, {
      storeId,
      storeType: "livs",
      city: "Malmö",
      openHoursPerWeek: 98,
      areaSqm: 400,
    });
    const profiles = await loadStoreProfilesFor(viewer);
    expect(profiles).toEqual([
      {
        id: storeId,
        name: "Ica Nära",
        storeType: "livs",
        city: "Malmö",
        openHoursPerWeek: 98,
        areaSqm: 400,
        archived: false,
      },
    ]);
  });

  it("läsaren och påfyllaren får inte ändra; påfyllaren får inte läsa", async () => {
    const input = {
      storeId,
      storeType: "kiosk",
      city: null,
      openHoursPerWeek: null,
      areaSqm: null,
    };
    await expect(saveStoreProfileFor(viewer, input)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(saveStoreProfileFor(refiller, input)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(loadStoreProfilesFor(refiller)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("en butik i en annan organisation går inte att ändra", async () => {
    await expect(
      saveStoreProfileFor(otherOwner, {
        storeId,
        storeType: "x",
        city: null,
        openHoursPerWeek: null,
        areaSqm: null,
      }),
    ).rejects.toBeInstanceOf(ExpansionError);
  });

  it("databasen nekar orimliga öppettider", async () => {
    await expect(
      saveStoreProfileFor(owner, {
        storeId,
        storeType: null,
        city: null,
        openHoursPerWeek: 200,
        areaSqm: null,
      }),
    ).rejects.toSatisfy((e) => pgError(e)?.code === "23514");
  });
});

describe("investeringar", () => {
  it("admin registrerar och ändrar; ändringen loggas", async () => {
    const id = await saveInvestmentFor(
      admin,
      investmentSchema.parse({
        machineId,
        kind: "purchase",
        amountOre: "39 900",
        investedOn: "2026-09-25",
        depreciationMonths: "60",
        note: "",
      }),
    );
    await saveInvestmentFor(
      owner,
      investmentSchema.parse({
        id,
        machineId,
        kind: "purchase",
        amountOre: "38 900,50",
        investedOn: "2026-09-25",
        depreciationMonths: "",
        note: "Rabatt",
      }),
    );
    const list = await loadInvestmentsFor(viewer);
    expect(list).toEqual([
      {
        id,
        machineId,
        kind: "purchase",
        amountOre: 3_890_050,
        investedOn: "2026-09-25",
        depreciationMonths: null,
        note: "Rabatt",
      },
    ]);
    const audit = await rows<{ action: string }>(
      db(),
      sql`select action::text from public.audit_log where table_name = 'machine_investments' and row_id = ${id} order by occurred_at`,
    );
    expect(audit.map((a) => a.action)).toEqual(["insert", "update"]);
  });

  it("läsaren får inte registrera", async () => {
    await expect(
      saveInvestmentFor(viewer, {
        id: null,
        machineId,
        kind: "other",
        amountOre: 100,
        investedOn: "2026-10-01",
        depreciationMonths: null,
        note: null,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("mål", () => {
  it("skapar, ändrar och tar bort; samma månad, mått och omfattning två gånger nekas", async () => {
    const input = goalSchema.parse({
      month: "2026-11",
      metric: "revenue",
      target: "50 000",
      scope: "store",
      storeId,
      machineId: machineId, // rensas: hör inte till omfattningen
    });
    expect(input.machineId).toBeNull();
    const id = await saveGoalFor(owner, input);
    await expect(saveGoalFor(owner, input)).rejects.toSatisfy((e) => pgError(e)?.code === "23505");
    await saveGoalFor(owner, { ...input, id, target: 6_000_000 });
    expect(await loadGoalsFor(viewer)).toEqual([
      {
        id,
        month: "2026-11",
        metric: "revenue",
        scope: "store",
        storeId,
        machineId: null,
        target: 6_000_000,
      },
    ]);
    await expect(deleteGoalFor(viewer, id)).rejects.toBeInstanceOf(AuthorizationError);
    await deleteGoalFor(admin, id);
    expect(await loadGoalsFor(owner)).toEqual([]);
    await expect(deleteGoalFor(owner, id)).rejects.toBeInstanceOf(ExpansionError);
  });

  it("antal automater anges som heltal", () => {
    expect(
      goalSchema.parse({
        month: "2026-12",
        metric: "active_machines",
        target: "5",
        scope: "organization",
      }).target,
    ).toBe(5);
    expect(() =>
      goalSchema.parse({
        month: "2026-12",
        metric: "active_machines",
        target: "5,5",
        scope: "organization",
      }),
    ).toThrow();
  });
});

describe("pipeline", () => {
  it("en ny plats går genom stegen; stage_changed_at följer steget", async () => {
    const id = await saveLeadFor(
      owner,
      leadSchema.parse({
        name: "Coop Kvarnby",
        stage: "lead",
        storeType: "livs",
        city: "Malmö",
        openHoursPerWeek: "84",
        areaSqm: "",
        contactName: "Eva",
        contactEmail: "eva@example.se",
        notes: "Träffades på mässan.",
        nextStep: "Ring",
        nextStepOn: "2026-11-10",
        commissionBp: "12,5",
        monthlyRentOre: "",
        purchaseOre: "39 900",
        installationOre: "2 500",
      }),
    );
    const [before] = await loadLeadsFor(viewer);
    expect(before).toMatchObject({
      id,
      name: "Coop Kvarnby",
      stage: "lead",
      openHoursPerWeek: 84,
      areaSqm: null,
      commissionBp: 1250,
      monthlyRentOre: null,
      purchaseOre: 3_990_000,
      installationOre: 250_000,
      nextStepOn: "2026-11-10",
    });
    await new Promise((r) => setTimeout(r, 20));
    await setLeadStageFor(admin, { id, stage: "meeting" });
    const [after] = await loadLeadsFor(owner);
    expect(after!.stage).toBe("meeting");
    expect(after!.stageChangedAt > before!.stageChangedAt).toBe(true);

    await expect(setLeadStageFor(viewer, { id, stage: "lost" })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(loadLeadsFor(refiller)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await loadLeadsFor(otherOwner)).toEqual([]);
    await expect(setLeadStageFor(otherOwner, { id, stage: "lost" })).rejects.toBeInstanceOf(
      ExpansionError,
    );

    const audit = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log where table_name = 'expansion_leads' and row_id = ${id}`,
    );
    expect(audit.n).toBe(2);

    await deleteLeadFor(owner, id);
    expect(await loadLeadsFor(owner)).toEqual([]);
  });

  it("påfyllaren ser inga leads ens direkt i databasen", async () => {
    await saveLeadFor(owner, leadSchema.parse({ name: "Synlig?", stage: "lead" }));
    const seen = await asUser({ id: refiller.user.userId, email: refiller.user.email }, (tx) =>
      rows(tx, sql`select id from public.expansion_leads`),
    );
    expect(seen).toEqual([]);
  });

  it("ogiltig e-post och procent över 100 nekas med svenska meddelanden", () => {
    const r = leadSchema.safeParse({
      name: "X",
      stage: "lead",
      contactEmail: "nej",
      commissionBp: "120",
    });
    expect(r.success).toBe(false);
    const messages = r.error!.issues.map((i) => i.message);
    expect(messages).toContain("Ange en giltig e-postadress.");
    expect(messages).toContain("Provision: ange en procentsats mellan 0 och 100.");
  });
});

describe("effekt", () => {
  it("utgångsläge i rätt enhet, mätvärden per månad och timkostnad", async () => {
    const b1 = await saveBaselineFor(
      owner,
      baselineSchema.parse({
        metric: "refill_hours_month",
        value: "12,5",
        scope: "organization",
        source: "Egen tidrapport, sommaren 2026",
        measuredFrom: "2026-06-01",
        measuredTo: "2026-08-31",
      }),
    );
    const b2 = await saveBaselineFor(
      owner,
      baselineSchema.parse({
        metric: "profit_per_machine_month",
        value: "2 500",
        scope: "machine",
        machineId,
      }),
    );
    const baselines = await loadBaselinesFor(viewer);
    expect(baselines.find((b) => b.id === b1)).toMatchObject({ value: 750, unit: "minutes" });
    expect(baselines.find((b) => b.id === b2)).toMatchObject({ value: 250_000, unit: "ore" });

    const m = await saveMeasurementFor(
      admin,
      measurementSchema.parse({
        metric: "refill_hours_month",
        month: "2026-10",
        value: "8",
        scope: "organization",
      }),
    );
    await expect(
      saveMeasurementFor(
        admin,
        measurementSchema.parse({
          metric: "refill_hours_month",
          month: "2026-10",
          value: "9",
          scope: "organization",
        }),
      ),
    ).rejects.toSatisfy((e) => pgError(e)?.code === "23505");
    expect(await loadMeasurementsFor(viewer)).toEqual([
      {
        id: m,
        metric: "refill_hours_month",
        scope: "organization",
        storeId: null,
        machineId: null,
        month: "2026-10",
        value: 480,
        note: null,
      },
    ]);

    expect(await loadEffectSettingsFor(viewer)).toEqual({
      hourlyCostOre: null,
      stockoutDayValueOre: null,
    });
    await saveEffectSettingsFor(owner, { hourlyCostOre: 25_000, stockoutDayValueOre: null });
    await saveEffectSettingsFor(admin, { hourlyCostOre: 30_000, stockoutDayValueOre: 10_000 });
    expect(await loadEffectSettingsFor(viewer)).toEqual({
      hourlyCostOre: 30_000,
      stockoutDayValueOre: 10_000,
    });
    await expect(
      saveEffectSettingsFor(viewer, { hourlyCostOre: 1, stockoutDayValueOre: null }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(loadEffectSettingsFor(refiller)).rejects.toBeInstanceOf(AuthorizationError);

    await deleteMeasurementFor(owner, m);
    await deleteBaselineFor(owner, b1);
    await deleteBaselineFor(owner, b2);
    expect(await loadMeasurementsFor(owner)).toEqual([]);
    expect(await loadBaselinesFor(owner)).toEqual([]);
    expect(otherOrgId).not.toBe(orgId);
  });

  it("vinst per automat kan inte lagras som mätvärde", async () => {
    const outcome = await asUser({ id: owner.user.userId, email: owner.user.email }, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.effect_measurements (organization_id, metric, month, value)
              values (${orgId}, 'profit_per_machine_month', '2026-10-01', 1)`,
        ),
      ),
    );
    expect(outcome.code).toBe("23514");
  });
});
