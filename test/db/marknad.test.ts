/**
 * Marknad (src/server/market) mot testdatabasen: behörighet och RLS för de nya tabellerna,
 * releaseförslag som fastställs och följs upp, leverantörspriser med avvikelser,
 * fackfördelning och genomförd sortimentsändring, och pristester.
 *
 * Organisationen byggs direkt som systemet: tre automater i en butik, en bastitel som
 * säljer hela året (prisändring 1 okt.), en titel med stadigt pris (pristest), tre tidigare
 * släpp i serien "SV" och ett kommande släpp 10 nov. "I dag" är 2 nov. 2026.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "../../src/db/schema";
import { addDays, eachDay, type IsoDate } from "../../src/domain";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";
import {
  assortmentView,
  buildMarketModel,
  priceTestProposals,
  pricesView,
  releaseViews,
} from "../../src/server/market/model";
import {
  createQuoteSchema,
  createReleaseSchema,
  saveSlotsSchema,
} from "../../src/server/market/schemas";
import {
  createQuoteFor,
  createReleaseFor,
  deleteQuoteFor,
  deleteReleaseFor,
  implementAssortmentFor,
  loadMarketDataFor,
  lockReleasePlanFor,
  MarketError,
  saveSlotsFor,
  startExperimentFor,
  stopExperimentFor,
  unlockReleasePlanFor,
  updateReleaseFor,
  type Viewer,
} from "../../src/server/market/service";

import {
  asPostgres,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const NOW = new Date("2026-11-02T10:00:00Z");
const TODAY = "2026-11-02";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

interface MarketOrg {
  orgId: string;
  owner: TestUser;
  viewer: TestUser;
  refiller: TestUser;
  machines: string[];
  titles: Record<"base" | "steady" | "a" | "b" | "c" | "n", string>;
  sourceId: string;
}

/** Order: en per (dag, automat, n) kl. 10 svensk tid (09:00Z vintertid / 08:00Z sommartid). */
function orderAt(date: IsoDate, i: number): Date {
  // 08:00Z är 09:00/10:00 svensk tid; samma affärsdag året om.
  return new Date(`${date}T08:${String(i % 60).padStart(2, "0")}:00Z`);
}

async function buildOrg(): Promise<MarketOrg> {
  const owner = await createUser(`mk-owner-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Marknad ${uniqueSuffix()}`);
  const viewer = await createMember(orgId, "viewer");
  const refiller = await createMember(orgId, "refiller");
  const org = { organizationId: orgId };

  return asPostgres(async (tx) => {
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Butik 1" })
      .returning();
    await tx
      .insert(s.storeAgreements)
      .values({ ...org, storeId: store!.id, validFrom: "2025-01-01", commissionBp: 1000 });
    const machines = await tx
      .insert(s.machines)
      .values(
        [1, 2, 3].map((n) => ({
          ...org,
          code: `BL-00${n}`,
          name: `Automat ${n}`,
          activeFrom: "2025-01-01",
        })),
      )
      .returning();
    await tx.insert(s.machinePlacements).values(
      machines.map((m) => ({
        ...org,
        machineId: m.id,
        storeId: store!.id,
        validFrom: "2025-01-01",
      })),
    );
    const titleRows = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Bas" },
        { ...org, name: "Stadig" },
        { ...org, name: "Släpp A", series: "SV" },
        { ...org, name: "Släpp B", series: "SV" },
        { ...org, name: "Släpp C", series: "SV" },
        { ...org, name: "Nytt släpp", series: "SV" },
      ])
      .returning();
    const [base, steady, a, b, c, n] = titleRows.map((t) => t.id) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    await tx.insert(s.purchasePrices).values(
      [base, steady, a, b, c, n].map((titleId) => ({
        ...org,
        titleId,
        unitCostOre: 2000,
        validFrom: "2025-01-01",
      })),
    );
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish" })
      .returning();

    type O = { titleId: string; machineId: string; date: IsoDate; amount: number };
    const list: O[] = [];
    const [m1, m2, m3] = machines.map((m) => m.id) as [string, string, string];
    // Bas: 1 per dag i M2 och M3, 3 per dag i M1. 49 kr till 30 sep., 54 kr från 1 okt.
    for (const date of eachDay("2026-01-05", TODAY)) {
      const amount = date < "2026-10-01" ? 4900 : 5400;
      for (let k = 0; k < 3; k++) list.push({ titleId: base, machineId: m1, date, amount });
      list.push({ titleId: base, machineId: m2, date, amount });
      list.push({ titleId: base, machineId: m3, date, amount });
    }
    // Stadig: 2 per dag och automat sedan 1 juli, alltid 59 kr.
    for (const date of eachDay("2026-07-01", TODAY)) {
      for (const machineId of [m1, m2, m3]) {
        list.push({ titleId: steady, machineId, date, amount: 5900 });
        list.push({ titleId: steady, machineId, date, amount: 5900 });
      }
    }
    // Tre släpp i serien SV: avtagande försäljning de första 28 dagarna.
    const releases: [string, IsoDate, number][] = [
      [a, "2026-03-02", 1],
      [b, "2026-05-04", 2],
      [c, "2026-07-06", 1],
    ];
    for (const [titleId, start, scale] of releases) {
      for (let d = 0; d < 28; d++) {
        const date = addDays(start, d);
        const perDay = d < 7 ? 3 * scale : d < 14 ? 2 * scale : 1;
        for (const machineId of [m1, m2, m3]) {
          for (let k = 0; k < perDay; k++) list.push({ titleId, machineId, date, amount: 6900 });
        }
      }
    }
    const values = list.map((o, i) => ({
      ...org,
      dataSourceId: source!.id,
      externalId: `X${i}`,
      rawTitle: "x",
      titleId: o.titleId,
      orderedAt: orderAt(o.date, i),
      amountOre: o.amount,
      machineId: o.machineId,
      sourceHash: `h${i}`,
    }));
    for (let i = 0; i < values.length; i += 1000) {
      await tx.insert(s.orders).values(values.slice(i, i + 1000));
    }
    return {
      orgId,
      owner,
      viewer,
      refiller,
      machines: [m1, m2, m3],
      titles: { base, steady, a, b, c, n },
      sourceId: source!.id,
    };
  });
}

let M: MarketOrg;
let ownerV: Viewer;

beforeAll(async () => {
  M = await buildOrg();
  ownerV = await viewerFor(M.owner, M.orgId);
}, 120_000);

describe("behörighet och RLS", () => {
  it("påfyllaren får varken laddaren eller raderna", async () => {
    const refV = await viewerFor(M.refiller, M.orgId);
    await expect(loadMarketDataFor(refV, NOW)).rejects.toBeInstanceOf(AuthorizationError);
    await createReleaseFor(
      ownerV,
      createReleaseSchema.parse({ name: "Synlig för ägaren", releaseDate: "2026-12-01" }),
    );
    for (const table of [
      "releases",
      "release_allocations",
      "supplier_price_quotes",
      "machine_slots",
      "assortment_changes",
      "price_experiments",
      "price_experiment_machines",
    ]) {
      const visible = await asUser(M.refiller, (tx) =>
        rows<{ n: number }>(tx, sql`select count(*)::int as n from ${sql.identifier(table)}`),
      );
      expect(visible[0]!.n, table).toBe(0);
    }
  });

  it("läsaren ser men kan inte ändra, varken via tjänsten eller direkt", async () => {
    const v = await viewerFor(M.viewer, M.orgId);
    const data = await loadMarketDataFor(v, NOW);
    expect(data.canEdit).toBe(false);
    expect(data.releases.length).toBeGreaterThan(0);
    await expect(
      createReleaseFor(v, createReleaseSchema.parse({ name: "X", releaseDate: "2026-12-01" })),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const direct = await asUser(M.viewer, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.releases (organization_id, name, release_date)
              values (${M.orgId}, 'X', '2026-12-01')`,
        ),
      ),
    );
    expect(direct.code).toBe("42501");
  });

  it("en annan organisations ägare ser inget och kan inte peka på våra titlar eller automater", async () => {
    const other = await createUser(`mk-other-${uniqueSuffix()}@test.binderlab.se`);
    const otherOrg = await createOrg(other, `Annan ${uniqueSuffix()}`);
    const seen = await asUser(other, (tx) =>
      rows<{ n: number }>(tx, sql`select count(*)::int as n from public.releases`),
    );
    expect(seen[0]!.n).toBe(0);
    const fk = await asUser(other, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.releases (organization_id, name, release_date, title_id)
              values (${otherOrg}, 'X', '2026-12-01', ${M.titles.a})`,
        ),
      ),
    );
    expect(fk.code).toBe("23503");
    const [title] = await asPostgres((tx) =>
      tx.insert(s.titles).values({ organizationId: otherOrg, name: "Egen" }).returning(),
    );
    const [experiment] = await asPostgres((tx) =>
      tx
        .insert(s.priceExperiments)
        .values({
          organizationId: otherOrg,
          titleId: title!.id,
          proposalKey: "price-test:x",
          direction: "up",
          fromOre: 100,
          toOre: 200,
          startedOn: "2026-11-03",
          testDays: 28,
        })
        .returning(),
    );
    const machineFk = await asUser(other, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.price_experiment_machines (organization_id, experiment_id,
                machine_id, arm)
              values (${otherOrg}, ${experiment!.id}, ${M.machines[0]}, 'test')`,
        ),
      ),
    );
    expect(machineFk.code).toBe("23503");
  });

  it("organization_id kan inte ändras och ändringar loggas", async () => {
    const id = await createReleaseFor(
      ownerV,
      createReleaseSchema.parse({ name: "Loggas", releaseDate: "2026-12-05" }),
    );
    const log = await asUser(M.owner, (tx) =>
      rows<{ action: string }>(
        tx,
        sql`select action::text as action from public.audit_log
            where table_name = 'releases' and row_id = ${id}`,
      ),
    );
    expect(log.map((l) => l.action)).toContain("insert");
    const move = await asUser(M.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.releases set organization_id = gen_random_uuid() where id = ${id}`,
        ),
      ),
    );
    expect(move.ok).toBe(false);
    await deleteReleaseFor(ownerV, id);
  });
});

describe("releaser", () => {
  let releaseId: string;

  it("förslaget räknas från tidigare släpp i serien och kan fastställas", async () => {
    releaseId = await createReleaseFor(
      ownerV,
      createReleaseSchema.parse({
        name: "Nytt släpp",
        series: "SV",
        releaseDate: "2026-11-10",
        titleId: M.titles.n,
        boxSize: "12",
      }),
    );
    const data = await loadMarketDataFor(ownerV, NOW);
    const view = releaseViews(data).find((r) => r.row.id === releaseId)!;
    expect(view.status).toBe("upcoming");
    expect(view.suggestion?.ok).toBe(true);
    if (!view.suggestion?.ok) return;
    const s = view.suggestion.value;
    expect(s.status).toBe("ok");
    expect(s.basis).toBe("series");
    expect(new Set(s.comparableTitleIds)).toEqual(new Set([M.titles.a, M.titles.b, M.titles.c]));
    expect(s.purchaseUnits % 12).toBe(0);
    expect(s.allocations).toHaveLength(3);
    expect(view.needsAction).toBe(true);

    const locked = await lockReleasePlanFor(ownerV, releaseId, NOW);
    expect(locked.purchaseUnits).toBe(s.purchaseUnits);
    await expect(lockReleasePlanFor(ownerV, releaseId, NOW)).rejects.toBeInstanceOf(MarketError);

    const after = await loadMarketDataFor(ownerV, NOW);
    const row = after.releases.find((r) => r.id === releaseId)!;
    expect(row.planLockedAt).not.toBeNull();
    expect(row.planLockedBy).toBe(M.owner.id);
    expect(row.planText).toBe(s.text);
    const allocations = after.allocations.filter((a) => a.releaseId === releaseId);
    expect(allocations.map((a) => a.units).sort()).toEqual(
      s.allocations.map((a) => a.units).sort(),
    );
    expect(releaseViews(after).find((r) => r.row.id === releaseId)!.needsAction).toBe(false);
  });

  it("fastställt förslag låser släppdag och storlek tills det låses upp", async () => {
    await expect(
      updateReleaseFor(ownerV, {
        id: releaseId,
        ...createReleaseSchema.parse({ name: "Nytt släpp", releaseDate: "2026-11-11" }),
      }),
    ).rejects.toBeInstanceOf(MarketError);
    await unlockReleasePlanFor(ownerV, releaseId);
    const data = await loadMarketDataFor(ownerV, NOW);
    expect(data.releases.find((r) => r.id === releaseId)!.planLockedAt).toBeNull();
    expect(data.allocations.filter((a) => a.releaseId === releaseId)).toHaveLength(0);
  });

  it("ett passerat släpp utan fastställt förslag jämförs med förslaget dagen före släppet", async () => {
    const id = await createReleaseFor(
      ownerV,
      createReleaseSchema.parse({
        name: "Släpp C",
        series: "SV",
        releaseDate: "2026-07-06",
        titleId: M.titles.c,
      }),
    );
    const data = await loadMarketDataFor(ownerV, NOW);
    const view = releaseViews(data).find((r) => r.row.id === id)!;
    expect(view.status).toBe("done");
    expect(view.suggestionAsOf).toBe("2026-07-05");
    expect(view.outcomeBasis).toBe("suggestion");
    expect(view.outcome?.ok).toBe(true);
    if (!view.outcome?.ok) return;
    // Släpp C sålde 3 × (7 × 3 + 7 × 2 + 14 × 1) = 147 pack de första 28 dagarna.
    expect(view.outcome.value.actual).toBe(147);
    expect(view.outcome.value.status).toBe("done");
    await deleteReleaseFor(ownerV, id);
  });
});

describe("leverantörspriser", () => {
  it("registrerade priser ger prisutveckling och flaggar ett dyrt inköp", async () => {
    const supplierName = `Grossist ${uniqueSuffix()}`;
    const prices = ["20,00", "20,20", "19,80", "20,10", "19,90", "20,00"];
    const ids: string[] = [];
    for (const [i, unitCost] of prices.entries()) {
      ids.push(
        await createQuoteFor(
          ownerV,
          createQuoteSchema.parse({
            supplierId: i === 0 ? "" : undefined,
            newSupplierName: supplierName,
            titleId: M.titles.a,
            quotedOn: addDays("2026-04-01", i * 14),
            unitCost,
            quantity: "36",
            kind: "purchase",
          }),
          NOW,
        ),
      );
    }
    const expensive = await createQuoteFor(
      ownerV,
      createQuoteSchema.parse({
        newSupplierName: supplierName.toUpperCase(),
        titleId: M.titles.a,
        quotedOn: "2026-10-20",
        unitCost: "26,00",
        quantity: "36",
        kind: "purchase",
      }),
      NOW,
    );
    // En lika dyr offert visas i prisutvecklingen men flaggas inte: bara inköp flaggas.
    const offer = await createQuoteFor(
      ownerV,
      createQuoteSchema.parse({
        newSupplierName: supplierName,
        titleId: M.titles.a,
        quotedOn: "2026-10-21",
        unitCost: "26,00",
        quantity: "36",
        kind: "quote",
      }),
      NOW,
    );
    const data = await loadMarketDataFor(ownerV, NOW);
    // Samma leverantör återanvänds (namnet jämförs utan skiftläge).
    expect(
      data.suppliers.filter((x) => x.name.toLowerCase() === supplierName.toLowerCase()),
    ).toHaveLength(1);
    const view = pricesView(data, { start: "2026-10-04", end: TODAY });
    expect(view.trends.ok).toBe(true);
    if (!view.trends.ok || !view.anomalies.ok) return;
    const trend = view.trends.value.find((t) => t.titleId === M.titles.a)!;
    expect(trend.purchases).toBe(8);
    // Median av sex inköp kring 20 kr och två à 26 kr (inköp och offert).
    expect(trend.medianOre).toBe(2005);
    expect(view.anomalies.value.map((a) => a.purchaseId)).toEqual([expensive]);
    expect(view.anomalies.value[0]!.direction).toBe("expensive");
    expect(view.anomalies.value[0]!.evidence.purchaseIds).toContain(ids[0]);

    await deleteQuoteFor(ownerV, expensive);
    await deleteQuoteFor(ownerV, offer);
    await expect(deleteQuoteFor(ownerV, expensive)).rejects.toBeInstanceOf(MarketError);
  });

  it("belopp tolkas exakt till öre", () => {
    const parsed = createQuoteSchema.parse({
      supplierId: randomUUID(),
      titleId: randomUUID(),
      quotedOn: TODAY,
      unitCost: "1 254,9",
    });
    expect(parsed.unitCost).toBe(125_490);
    expect(() =>
      createQuoteSchema.parse({
        supplierId: randomUUID(),
        titleId: randomUUID(),
        quotedOn: TODAY,
        unitCost: "-5",
      }),
    ).toThrow();
  });
});

describe("sortiment", () => {
  const PERIOD = { start: "2026-10-06", end: TODAY };

  it("fackfördelning sparas per period och ersätts från ett datum", async () => {
    const m1 = M.machines[0]!;
    await saveSlotsFor(
      ownerV,
      saveSlotsSchema.parse({
        machineId: m1,
        validFrom: "2026-09-01",
        lines: [
          { titleId: M.titles.base, slots: 1 },
          { titleId: M.titles.a, slots: 1 },
        ],
      }),
    );
    // Ny fördelning från 1 okt.: Släpp A tas bort, Stadig får 3 fack.
    await saveSlotsFor(
      ownerV,
      saveSlotsSchema.parse({
        machineId: m1,
        validFrom: "2026-10-01",
        lines: [
          { titleId: M.titles.base, slots: 1 },
          { titleId: M.titles.steady, slots: 3 },
        ],
      }),
    );
    const data = await loadMarketDataFor(ownerV, NOW);
    const rowsM1 = data.slots.filter((x) => x.machineId === m1);
    expect(
      rowsM1
        .map(
          (x) =>
            `${x.titleId === M.titles.a ? "a" : x.titleId === M.titles.base ? "base" : "steady"}:${x.validFrom}:${x.validTo}`,
        )
        .sort(),
    ).toEqual([
      "a:2026-09-01:2026-09-30",
      "base:2026-09-01:2026-09-30",
      "base:2026-10-01:null",
      "steady:2026-10-01:null",
    ]);
    expect(() =>
      saveSlotsSchema.parse({
        machineId: m1,
        validFrom: TODAY,
        lines: [
          { titleId: M.titles.a, slots: 1 },
          { titleId: M.titles.a, slots: 1 },
        ],
      }),
    ).toThrow();
  });

  it("rekommendationen genomförs: ny fackfördelning och uppföljning", async () => {
    const m1 = M.machines[0]!;
    const data = await loadMarketDataFor(ownerV, NOW);
    const view = assortmentView(data, PERIOD);
    expect(view.machines.ok).toBe(true);
    if (!view.machines.ok) return;
    const rec = view.machines.value.find((m) => m.machineId === m1)!.recommendation!;
    expect(rec.action).toBe("change");
    expect(rec.effectPerWeekOre).toBeGreaterThan(0);
    expect(view.withoutSlots.map((m) => m.code)).toEqual(["BL-002", "BL-003"]);

    await expect(
      implementAssortmentFor(
        ownerV,
        {
          machineId: m1,
          fingerprint: "fel",
          implementedOn: TODAY,
          periodStart: PERIOD.start,
          periodEnd: PERIOD.end,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(MarketError);

    const done = await implementAssortmentFor(
      ownerV,
      {
        machineId: m1,
        fingerprint: rec.fingerprint,
        implementedOn: TODAY,
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
      },
      NOW,
    );
    expect(done.effectPerWeekOre).toBe(rec.effectPerWeekOre);

    const after = await loadMarketDataFor(ownerV, NOW);
    const today = after.slots.filter(
      (x) =>
        x.machineId === m1 && x.validFrom <= TODAY && (x.validTo === null || x.validTo >= TODAY),
    );
    const expected = rec.lines.filter((l) => l.recommendedSlots > 0);
    expect(today.map((x) => `${x.titleId}:${x.slots}`).sort()).toEqual(
      expected.map((l) => `${l.titleId}:${l.recommendedSlots}`).sort(),
    );
    // Tidigare fördelning avslutad dagen före.
    expect(after.slots.some((x) => x.machineId === m1 && x.validTo === "2026-11-01")).toBe(true);
    const change = after.assortmentChanges.find((c) => c.id === done.id)!;
    expect(change.expectedEffectPerWeekOre).toBe(rec.effectPerWeekOre);
    expect(change.text).toBe(rec.text);
    const model = buildMarketModel(after, PERIOD);
    const followUp = model.assortment.followUps.find((f) => f.change.id === done.id)!;
    expect(followUp.followUp.ok).toBe(true);
    // Genomförd i dag: uppföljningen räknar bara hela dagar, så den har inte börjat.
    if (followUp.followUp.ok) expect(followUp.followUp.value.status).toBe("not-started");
    expect(
      model.assortment.machines.ok && model.assortment.machines.value[0]?.implemented?.id,
    ).toBe(done.id);
  });
});

describe("prissättning", () => {
  it("prisändringen 1 okt. hittas och effekten räknas", async () => {
    const data = await loadMarketDataFor(ownerV, NOW);
    const model = buildMarketModel(data, { start: "2026-09-15", end: TODAY });
    expect(model.pricing.changes.ok).toBe(true);
    if (!model.pricing.changes.ok) return;
    const change = model.pricing.changes.value.find((c) => c.change.titleId === M.titles.base)!;
    expect(change.change.date).toBe("2026-10-01");
    expect(change.change.fromOre).toBe(4900);
    expect(change.change.toOre).toBe(5400);
    expect(change.effect.ok).toBe(true);
  });

  it("ett föreslaget pristest startas, och tas bort när det stoppas före start", async () => {
    const data = await loadMarketDataFor(ownerV, NOW);
    const proposal = priceTestProposals(data).find((p) => p.titleId === M.titles.steady);
    expect(proposal?.experiment).toBe(true);
    if (!proposal) return;
    const started = await startExperimentFor(ownerV, { proposalKey: proposal.key }, NOW);
    // Underlaget räknas till och med i går (sista hela dagen); testet börjar i dag.
    expect(started.startedOn).toBe(TODAY);
    expect(proposal.evidence.period?.end).toBe("2026-11-01");
    const after = await loadMarketDataFor(ownerV, NOW);
    const row = after.experiments.find((e) => e.id === started.id)!;
    expect(row.testMachineIds.length + row.controlMachineIds.length).toBe(3);
    // Titeln föreslås inte igen medan testet pågår.
    expect(priceTestProposals(after).some((p) => p.titleId === M.titles.steady)).toBe(false);
    await expect(
      startExperimentFor(ownerV, { proposalKey: proposal.key }, NOW),
    ).rejects.toBeInstanceOf(MarketError);
    expect(await stopExperimentFor(ownerV, started.id, NOW)).toBe("deleted");
    const gone = await loadMarketDataFor(ownerV, NOW);
    expect(gone.experiments.some((e) => e.id === started.id)).toBe(false);
  });
});

describe("granskningens rättelser", () => {
  const PERIOD = { start: "2026-10-06", end: TODAY };

  it("samma pristest kan inte startas flera gånger samtidigt", async () => {
    const data = await loadMarketDataFor(ownerV, NOW);
    const proposal = priceTestProposals(data).find((p) => p.titleId === M.titles.steady)!;
    expect(proposal).toBeDefined();
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => startExperimentFor(ownerV, { proposalKey: proposal.key }, NOW)),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(MarketError);
    }
    const after = await loadMarketDataFor(ownerV, NOW);
    const mine = after.experiments.filter((e) => e.titleId === M.titles.steady);
    expect(mine).toHaveLength(1);
    expect(await stopExperimentFor(ownerV, mine[0]!.id, NOW)).toBe("deleted");
  });

  it("en sortimentsändring genomförs en gång och låser fackhistoriken bakåt", async () => {
    const m2 = M.machines[1]!;
    await saveSlotsFor(
      ownerV,
      saveSlotsSchema.parse({
        machineId: m2,
        validFrom: "2026-10-01",
        lines: [
          { titleId: M.titles.base, slots: 3 },
          { titleId: M.titles.steady, slots: 1 },
        ],
      }),
      NOW,
    );
    const data = await loadMarketDataFor(ownerV, NOW);
    const view = assortmentView(data, PERIOD);
    // Analysperioden slutar i går, sista hela dagen.
    expect(view.period.end).toBe("2026-11-01");
    const rec = view.machines.ok
      ? view.machines.value.find((m) => m.machineId === m2)?.recommendation
      : null;
    expect(rec?.action).toBe("change");
    if (!rec) return;
    const input = (implementedOn: IsoDate) => ({
      machineId: m2,
      fingerprint: rec.fingerprint,
      implementedOn,
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    });
    // Inom mätperioden och för långt bakåt nekas.
    await expect(implementAssortmentFor(ownerV, input("2026-11-01"), NOW)).rejects.toThrow(
      /efter rekommendationens mätperiod/,
    );
    await expect(implementAssortmentFor(ownerV, input("2026-10-20"), NOW)).rejects.toThrow(
      /högst 7 dagar bakåt/,
    );

    const results = await Promise.allSettled(
      [1, 2, 3].map(() => implementAssortmentFor(ownerV, input(TODAY), NOW)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(MarketError);
    }
    const after = await loadMarketDataFor(ownerV, NOW);
    expect(after.assortmentChanges.filter((c) => c.machineId === m2)).toHaveLength(1);

    // Fackfördelningen från genomförandedagen och bakåt kan inte skrivas över.
    for (const validFrom of [TODAY, "2026-10-15"]) {
      await expect(
        saveSlotsFor(
          ownerV,
          saveSlotsSchema.parse({
            machineId: m2,
            validFrom,
            lines: [{ titleId: M.titles.base, slots: 1 }],
          }),
          NOW,
        ),
      ).rejects.toThrow(/kan inte skrivas över/);
    }
    const slotsAfter = (await loadMarketDataFor(ownerV, NOW)).slots.filter(
      (x) => x.machineId === m2 && x.validFrom === TODAY,
    );
    expect(slotsAfter.length).toBeGreaterThan(0);
  });

  it("släpp: en titel per släpp, främmande id och byte av titel på fastställt förslag nekas", async () => {
    await expect(
      createReleaseFor(
        ownerV,
        createReleaseSchema.parse({ name: "Igen", releaseDate: "2026-12-01", titleId: M.titles.n }),
      ),
    ).rejects.toThrow(/Titeln har redan ett släpp/);
    await expect(
      createReleaseFor(
        ownerV,
        createReleaseSchema.parse({
          name: "Främmande",
          releaseDate: "2026-12-01",
          titleId: randomUUID(),
        }),
      ),
    ).rejects.toThrow("Titeln finns inte.");
    await expect(
      createReleaseFor(
        ownerV,
        createReleaseSchema.parse({
          name: "Främmande",
          releaseDate: "2026-12-01",
          supplierId: randomUUID(),
        }),
      ),
    ).rejects.toThrow("Leverantören finns inte.");

    // Ett släpp utan titel fastställs; titeln får kopplas men sedan inte bytas.
    const fields = { name: "Okänd titel", series: "SV", releaseDate: "2026-11-20" };
    const id = await createReleaseFor(ownerV, createReleaseSchema.parse(fields));
    await lockReleasePlanFor(ownerV, id, NOW);
    await updateReleaseFor(ownerV, {
      id,
      ...createReleaseSchema.parse({ ...fields, titleId: M.titles.b }),
    });
    await expect(
      updateReleaseFor(ownerV, {
        id,
        ...createReleaseSchema.parse({ ...fields, titleId: M.titles.a }),
      }),
    ).rejects.toThrow(/fastställt för en annan titel/);
    await deleteReleaseFor(ownerV, id);
  });

  it("inköpspriser: rimligt datum, 0 kr kräver anteckning, främmande leverantör nekas", async () => {
    const base = { newSupplierName: `Datum ${uniqueSuffix()}`, titleId: M.titles.a };
    await expect(
      createQuoteFor(
        ownerV,
        createQuoteSchema.parse({ ...base, quotedOn: "2099-12-31", unitCost: "20" }),
        NOW,
      ),
    ).rejects.toThrow(/högst 90 dagar fram/);
    await expect(
      createQuoteFor(
        ownerV,
        createQuoteSchema.parse({ ...base, quotedOn: TODAY, unitCost: "0" }),
        NOW,
      ),
    ).rejects.toThrow(/0 kr kräver en anteckning/);
    const free = await createQuoteFor(
      ownerV,
      createQuoteSchema.parse({ ...base, quotedOn: TODAY, unitCost: "0", note: "Gratisexemplar" }),
      NOW,
    );
    await deleteQuoteFor(ownerV, free);
    await expect(
      createQuoteFor(
        ownerV,
        createQuoteSchema.parse({
          supplierId: randomUUID(),
          titleId: M.titles.a,
          quotedOn: TODAY,
          unitCost: "20",
        }),
        NOW,
      ),
    ).rejects.toThrow("Leverantören finns inte.");
  });
});
