/**
 * Fas 7, integrationen mellan delarna, mot testdatabasen med seedens data i en egen
 * organisation:
 *
 * - Att göra: avtal (påminnelse 90 dagar före sista uppsägningsdag), rapportutkast att
 *   granska, larm som kräver åtgärd, prioritering efter förlorad försäljning, avbockade
 *   punkter vars orsak är löst, och roller (påfyllaren och läsaren).
 * - Hem: "Slutsålt kostade …" är Prognos egen siffra.
 * - Automater visar samma maskinstatus som Drift.
 * - Lager och Drift planerar samma besöksdagar.
 * - Lönsamhet: återbetalningar och fasta kostnader som egna rader; summorna går ihop.
 * - Seeden: bankkontot 1930.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Tx } from "@/db/client";
import type { OrganizationMembership, SessionUser } from "@/server/access";

const session = vi.hoisted(() => ({
  current: null as null | { user: SessionUser; organization: OrganizationMembership },
}));

vi.mock("@/server/session", async () => {
  const access = await import("@/server/access");
  const who = () => {
    if (!session.current) throw new Error("Ingen inloggad i testet.");
    return session.current;
  };
  return {
    AuthorizationError: access.AuthorizationError,
    getSessionUser: async () => session.current?.user ?? null,
    requireUser: async () => who().user,
    getActiveOrganization: async () => who().organization,
    withUserDb: <T>(fn: (tx: Tx) => Promise<T>) => access.withUserDbFor(who().user, fn),
    requireRole: async (organizationId: string, roles: readonly string[]) => {
      const user = who().user;
      const role = await access.requireRoleFor(user, organizationId, roles as never);
      return { user, role };
    },
  };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  permanentRedirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_noStore: vi.fn(),
}));

import { loadHomeWith } from "@/app/(app)/_hem/data";
import { dismissTodoFor, loadDismissedFor } from "@/app/(app)/att-gora/_lib/service";
import { loadOverview } from "@/app/(app)/automater/_lib/data";
import { loadDriftOverview } from "@/app/(app)/drift/_lib/load";
import { loadLagerFor } from "@/app/(app)/lager/_lib/data";
import { resultAfterProfit } from "@/app/(app)/lonsamhet/_lib/result";
import { LOST_REVENUE_FIGURE, type TodoItem } from "@/analytics/todos";
import { profitability } from "@/domain";
import { LocalFileStore } from "@/import/file-store";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import {
  loadContextFor,
  loadDomainInputFor,
  loadTodosFor,
  loadTodoStateFor,
  type Viewer,
} from "@/server/data/core/loaders";
import { loadContext } from "@/server/data/core";
import { loadProfitAdjustmentsFor } from "@/server/data/adjustments";
import { loadMachineHealthFor } from "@/server/data/health";
import { loadRankedTodoStateFor } from "@/server/data/todos";
import { loadReportsPage } from "@/server/reports/page-data";
import { lostSalesSummaryFor } from "@/server/purchasing";
import { runSeed } from "@/seed/run-seed";

import { asPostgres, asUser, createMember, db, one, rows, uniqueSuffix } from "./helpers";

/** Måndag 2 nov. 2026 11:00 svensk tid; seedens order går 13 okt.–1 nov. */
const NOW = new Date("2026-11-02T10:00:00Z");
const OCT = { start: "2026-10-01", end: "2026-10-31" };

let orgId: string;
let owner: Viewer;
let reader: Viewer;
let refiller: Viewer;
let ownerTest: { id: string; email: string };
const machineIds = new Map<string, string>();
const storeIds = new Map<string, string>();

async function viewerOf(user: SessionUser): Promise<Viewer> {
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

function as<T>(who: Viewer, fn: () => Promise<T>): Promise<T> {
  session.current = who;
  return fn();
}

const keysOf = (todos: readonly TodoItem[]) => todos.map((t) => t.key);

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const ownerEmail = `int-agare-${suffix}@test.binderlab.se`;
  const seeded = await runSeed(db(), {
    password: "binderlab-integration",
    manageUsers: true,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-integration-"))),
    organization: { name: `Integration ${suffix}`, slug: `integration-${suffix}` },
    users: {
      owner: { email: ownerEmail, fullName: "Ägare", role: "owner" },
      partner: {
        email: `int-delagare-${suffix}@test.binderlab.se`,
        fullName: "Delägare",
        role: "viewer",
      },
    },
  });
  orgId = seeded.organizationId;
  ownerTest = { id: seeded.users.owner, email: ownerEmail };
  owner = await viewerOf({ userId: seeded.users.owner, email: ownerEmail });
  reader = await viewerOf({
    userId: seeded.users.partner,
    email: `int-delagare-${suffix}@test.binderlab.se`,
  });
  const r = await createMember(orgId, "refiller");
  refiller = await viewerOf({ userId: r.id, email: r.email });

  for (const m of await rows<{ id: string; code: string }>(
    db(),
    sql`select id, code from public.machines where organization_id = ${orgId}::uuid`,
  )) {
    machineIds.set(m.code, m.id);
  }
  for (const s of await rows<{ id: string; name: string }>(
    db(),
    sql`select id, name from public.stores where organization_id = ${orgId}::uuid order by name`,
  )) {
    storeIds.set(s.name, s.id);
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Att göra
// ---------------------------------------------------------------------------

describe("Att göra: avtal, rapportutkast och larm", () => {
  let contractId: string;
  let reportId: string;
  let alertId: string;

  beforeAll(async () => {
    const storeId = [...storeIds.values()][0]!;
    // Avtal som slutar 28 feb. 2027 med 3 månaders uppsägning: sista dag 30 nov., 28 dagar kvar.
    contractId = await asUser(ownerTest, async (tx) => {
      const row = await one<{ id: string }>(
        tx,
        sql`insert into public.contracts (organization_id, store_id, title, valid_from, valid_to,
                                          notice_period_months)
            values (${orgId}::uuid, ${storeId}::uuid, 'Placeringsavtal', '2026-01-01', '2027-02-28', 3)
            returning id`,
      );
      return row.id;
    });
    // Utkast för oktober (systemet skapar dem den 1:a), för den sista butiken i namnordning:
    // Rapporter väljer annars den första butiken, så länken måste peka ut butiken.
    const draftStoreId = [...storeIds.values()].at(-1)!;
    reportId = await asPostgres(async (tx) => {
      const row = await one<{ id: string }>(
        tx,
        sql`insert into public.reports (organization_id, kind, period_start, period_end, store_id,
                                        storage_path, data_snapshot, calc_version, generated_at)
            values (${orgId}::uuid, 'store_statement', '2026-10-01', '2026-10-31', ${draftStoreId}::uuid,
                    ${`${orgId}/2026-10/utkast.pdf`}, '{}'::jsonb, 'test', '2026-11-01T05:17:00Z')
            returning id`,
      );
      return row.id;
    });
    // Ett öppet, kritiskt larm om BL-001 (larmjobbet skriver som systemet).
    const machineId = machineIds.get("BL-001")!;
    alertId = await asPostgres(async (tx) => {
      const row = await one<{ id: string }>(
        tx,
        sql`insert into public.alerts (organization_id, kind, severity, machine_id, incident_key,
                                       alert_group, status, title, message, triggered_at, link)
            values (${orgId}::uuid, 'machine_suspected_fault', 'critical', ${machineId}::uuid,
                    ${`machine:${machineId}`}, 'machine', 'open', 'BL-001 har slutat sälja',
                    'Ingen försäljning på 6 timmar mot väntat 5 order.', '2026-11-02T07:00:00Z',
                    '/drift')
            returning id`,
      );
      return row.id;
    });
  });

  it("ägaren får avtalet, utkasten och larmet som punkter med länk till underlaget", async () => {
    const todos = await loadTodosFor(owner, NOW);
    const contract = todos.find((t) => t.kind === "contract");
    expect(contract?.key).toBe(`contract:${contractId}:2027-02-28`);
    expect(contract?.level).toBe("soon");
    expect(contract?.daysLeft).toBe(28);
    expect(contract?.link).toBe(`/avtal#avtal-${contractId}`);

    const review = todos.find((t) => t.kind === "report-review");
    expect(review?.key).toBe("report-review:2026-10");
    expect(review?.title).toBe("Granska rapportutkastet för oktober");
    const draftStoreId = [...storeIds.values()].at(-1)!;
    expect(review?.link).toBe(`/rapporter?typ=butik&manad=2026-10&butiken=${draftStoreId}#granska`);
    // Länken öppnar utkastet i granskningen (inte "Inget utkast att granska").
    const url = new URL(review!.link!, "http://x");
    const page = await loadReportsPage(owner, Object.fromEntries(url.searchParams.entries()), NOW);
    expect(page.type).toBe("butik");
    expect(page.storeId).toBe(draftStoreId);
    expect(page.current?.id).toBe(reportId);
    expect(page.current?.status).toBe("draft");

    const alert = todos.find((t) => t.kind === "alert");
    expect(alert?.key).toBe(`alert:machine:${machineIds.get("BL-001")}`);
    expect(alert?.level).toBe("now");
    expect(alert?.link).toBe(`/drift/automat/${machineIds.get("BL-001")}`);
  });

  it("påfyllaren och läsaren får inga sådana punkter", async () => {
    const r = await loadTodosFor(refiller, NOW);
    expect(r.some((t) => ["contract", "report-review", "alert"].includes(t.kind))).toBe(false);
    expect(r.every((t) => t.kind === "refill" || t.kind === "stale-machine")).toBe(true);
    expect(await loadTodosFor(reader, NOW)).toEqual([]);
  });

  it("menyns räknare och listan har samma punkter; förlorad försäljning ändrar bara ordningen", async () => {
    const plain = await loadTodosFor(owner, NOW);
    const ranked = await loadRankedTodoStateFor(owner, NOW);
    expect([...keysOf(ranked.items)].sort()).toEqual([...keysOf(plain)].sort());
    // Nivån först, sedan brådskan.
    const rank = { now: 0, soon: 1, later: 2 } as const;
    for (let i = 1; i < ranked.items.length; i++) {
      const a = ranked.items[i - 1]!;
      const b = ranked.items[i]!;
      expect(rank[a.level] <= rank[b.level]).toBe(true);
      if (a.level === b.level) expect(a.urgency >= b.urgency).toBe(true);
    }
    // Beloppet i underlaget är Prognos egen siffra för titeln i automaten.
    const lost = await lostSalesSummaryFor(owner, { start: "2026-10-19", end: "2026-11-01" }, NOW);
    for (const t of ranked.items.filter((x) => x.kind === "refill")) {
      const figure = t.evidence.figures.find((f) => f.key === LOST_REVENUE_FIGURE)?.value ?? 0;
      const expected = lost.series.find((s) => s.key === t.key)?.lostRevenueOre ?? 0;
      expect(figure, t.key).toBe(expected);
    }
    // Påfyllaren får listan utan belopp.
    const forRefiller = await loadRankedTodoStateFor(refiller, NOW);
    for (const t of forRefiller.items) {
      expect(t.evidence.figures.some((f) => f.unit === "ore")).toBe(false);
    }
  });

  it("en avbockning vars orsak är löst syns inte under Avbockade", async () => {
    const before = await loadTodosFor(owner, NOW);
    const contract = before.find((t) => t.kind === "contract")!;
    const res = await dismissTodoFor(
      owner,
      { key: contract.key, fingerprint: contract.fingerprint },
      NOW,
    );
    expect(res.ok).toBe(true);

    const state = await loadTodoStateFor(owner, NOW);
    expect(keysOf(state.items)).not.toContain(contract.key);
    expect(keysOf(state.dismissed)).toContain(contract.key);
    const listed = await loadDismissedFor(
      owner,
      new Set(keysOf(state.items)),
      NOW,
      new Set(keysOf(state.dismissed)),
    );
    expect(listed.map((d) => d.key)).toContain(contract.key);

    // Avtalet förlängs: orsaken är löst.
    await asUser(ownerTest, (tx) =>
      tx.execute(sql`update public.contracts set valid_to = '2028-02-29'
                     where organization_id = ${orgId}::uuid and id = ${contractId}::uuid`),
    );
    const after = await loadTodoStateFor(owner, NOW);
    expect(keysOf(after.dismissed)).not.toContain(contract.key);
    const listedAfter = await loadDismissedFor(
      owner,
      new Set(keysOf(after.items)),
      NOW,
      new Set(keysOf(after.dismissed)),
    );
    expect(listedAfter.map((d) => d.key)).not.toContain(contract.key);
    // Utan filtret (som förut) hade den stått kvar.
    const old = await loadDismissedFor(owner, new Set(keysOf(after.items)), NOW);
    expect(old.map((d) => d.key)).toContain(contract.key);
  });

  it("godkänt utkast och kvitterat larm försvinner ur listan", async () => {
    await asPostgres(async (tx) => {
      await tx.execute(sql`insert into public.report_approvals (organization_id, report_id, approved_by)
                           values (${orgId}::uuid, ${reportId}::uuid, ${owner.user.userId}::uuid)`);
      await tx.execute(sql`update public.alerts set acknowledged_at = now(),
                             acknowledged_by = ${owner.user.userId}::uuid
                           where id = ${alertId}::uuid`);
    });
    const todos = await loadTodosFor(owner, NOW);
    expect(todos.some((t) => t.kind === "report-review")).toBe(false);
    expect(todos.some((t) => t.kind === "alert")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hem
// ---------------------------------------------------------------------------

describe("Hem: slutsålt och Att göra", () => {
  it("visar Prognos siffra för förlorad försäljning och Att göra i prioriterad ordning", async () => {
    const lost = await lostSalesSummaryFor(owner, OCT, NOW);
    const data = await as(owner, () =>
      loadHomeWith(
        {
          context: () => loadContext(),
          period: () =>
            Promise.resolve({
              key: "custom",
              period: OCT,
              compare: null,
              dataStart: "2026-10-13",
              scope: { storeId: null, machineId: null },
            } as never),
          domainInput: (args) => loadDomainInputFor(owner, args, NOW),
          todos: async () => (await loadRankedTodoStateFor(owner, NOW)).items,
          lostSales: (period) => lostSalesSummaryFor(owner, period, NOW),
        },
        {},
      ),
    );
    if (lost.lostRevenueOre > 0) {
      expect(data.lostSales?.text).toBe(lost.text);
      expect(data.lostSales?.href).toBe(lost.href);
      expect(data.lostSales?.text).toMatch(/^Slutsålt kostade ca .* i oktober\.$/);
    } else {
      expect(data.lostSales).toBeNull();
    }
    expect(data.model.todoCount).toBe((await loadTodosFor(owner, NOW)).length);
  });

  it("läsaren får siffran, påfyllaren får ingen ekonomi", async () => {
    const lost = await lostSalesSummaryFor(reader, OCT, NOW);
    expect(lost.lostRevenueOre).toBeGreaterThanOrEqual(0);
    await expect(lostSalesSummaryFor(refiller, OCT, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Automater och Drift
// ---------------------------------------------------------------------------

describe("Automater visar samma maskinstatus som Drift", () => {
  it("varje automat har samma hälsa på båda sidorna", async () => {
    const [overview, drift] = await as(owner, async () => {
      const ctx = await loadContext();
      return Promise.all([loadOverview({}), loadDriftOverview(ctx)]);
    });
    const driftStatus = new Map(drift.health.map((h) => [h.machineId, h.status]));
    const active = overview.overview.rows.filter((r) => r.lifecycle === "active");
    expect(active.length).toBeGreaterThan(0);
    for (const row of active) {
      expect(row.status.health, row.code).toBe(driftStatus.get(row.id) ?? null);
    }
  });

  it("hälsan är densamma för ägaren och påfyllaren", async () => {
    const a = await loadMachineHealthFor(owner, NOW);
    const b = await loadMachineHealthFor(refiller, NOW);
    expect(b.map((h) => [h.machineId, h.status])).toEqual(a.map((h) => [h.machineId, h.status]));
  });
});

describe("Lager och Drift planerar samma besök", () => {
  it("samma besöksdag per automat, med gårdagens takt", async () => {
    const ctx = await loadContextFor(owner, await listOrganizationsFor(owner.user), NOW);
    const [lager, drift] = await as(owner, () =>
      Promise.all([
        loadLagerFor(owner, { period: OCT, scope: { storeId: null, machineId: null } }, NOW),
        loadDriftOverview(ctx),
      ]),
    );
    const driftDay = new Map<string, string>();
    for (const d of drift.plan.days) for (const s of d.stops) driftDay.set(s.machineId, d.date);
    expect(lager.packLists.length).toBeGreaterThan(0);
    for (const p of lager.packLists) {
      expect(p.plannedDay, p.machineId).toBe(driftDay.get(p.machineId) ?? null);
    }
  });

  it("ett besök i dag har samma packlista på Lager och Drift (inget dras från dagens saldo)", async () => {
    const ctx = await loadContextFor(owner, await listOrganizationsFor(owner.user), NOW);
    const [lager, drift] = await as(owner, () =>
      Promise.all([
        loadLagerFor(owner, { period: OCT, scope: { storeId: null, machineId: null } }, NOW),
        loadDriftOverview(ctx),
      ]),
    );
    const today = drift.plan.days.find((d) => d.date === "2026-11-02");
    let compared = 0;
    for (const stop of today?.stops ?? []) {
      const list = lager.packLists.find((p) => p.machineId === stop.machineId);
      expect(list, stop.machineId).toBeDefined();
      for (const line of list!.lines) {
        const pack = stop.packs.find((x) => x.titleId === line.titleId);
        expect(pack, line.titleName).toBeDefined();
        // Lager vid besöket = saldot nu; behovet (att ta med + saknas i centrallagret) lika.
        expect(pack!.projectedAtVisit, line.titleName).toBe(line.onHand);
        expect(pack!.quantity + pack!.shortBy, line.titleName).toBe(line.quantity + line.shortBy);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Lönsamhet
// ---------------------------------------------------------------------------

describe("Lönsamhet: återbetalningar och fasta kostnader", () => {
  beforeAll(async () => {
    const machineId = machineIds.get("BL-002")!;
    await asUser(ownerTest, async (tx) => {
      await tx.execute(sql`insert into public.incidents (organization_id, machine_id, kind, started_at,
                                                          description, refunded_ore, refunded_on)
                           values (${orgId}::uuid, ${machineId}::uuid, 'customer', '2026-10-20T12:00:00Z',
                                   'Fick inget pack', 4900, '2026-10-20')`);
      await tx.execute(sql`insert into public.fixed_costs (organization_id, name, category, amount_ore,
                                                            interval, starts_on)
                           values (${orgId}::uuid, 'Försäkring', 'insurance', 31000, 'month', '2026-10-01')`);
    });
  });

  it("raderna går ihop med vattenfallet och per automat", async () => {
    const input = await loadDomainInputFor(owner, { period: OCT }, NOW);
    const adj = await loadProfitAdjustmentsFor(owner, OCT);
    expect(adj.refunds.map((r) => r.amountOre)).toEqual([4900]);
    const r = resultAfterProfit({
      current: input.current,
      organization: input.current,
      refunds: adj.refunds,
      fixedCosts: adj.fixedCosts,
      scope: { storeId: null, machineId: null },
    });
    expect(r.profitOre).toBe(profitability(input.current, "title").totals.profitOre);
    expect(r.refundOre).toBe(4900);
    expect(r.fixedCostOre).toBe(31000); // hela oktober
    expect(r.resultOre).toBe(r.profitOre - 4900 - 31000);
    const sum = (k: "profitOre" | "refundOre" | "fixedCostOre" | "resultOre") =>
      r.machines.reduce((n, m) => n + m[k], 0);
    expect(sum("profitOre")).toBe(r.profitOre);
    expect(sum("refundOre")).toBe(r.refundOre);
    expect(sum("fixedCostOre")).toBe(r.fixedCostOre);
    expect(sum("resultOre")).toBe(r.resultOre);
  });

  it("automatfilter: BL-002 bär sin återbetalning och sin del av försäkringen", async () => {
    const machineId = machineIds.get("BL-002")!;
    const org = await loadDomainInputFor(owner, { period: OCT }, NOW);
    const one_ = await loadDomainInputFor(owner, { period: OCT, machineId }, NOW);
    const adj = await loadProfitAdjustmentsFor(owner, OCT);
    const all = resultAfterProfit({
      current: org.current,
      organization: org.current,
      refunds: adj.refunds,
      fixedCosts: adj.fixedCosts,
      scope: { storeId: null, machineId: null },
    });
    const r = resultAfterProfit({
      current: one_.current,
      organization: org.current,
      refunds: adj.refunds,
      fixedCosts: adj.fixedCosts,
      scope: { storeId: null, machineId },
    });
    const row = all.machines.find((m) => m.key === machineId)!;
    expect(r.refundOre).toBe(4900);
    expect(r.fixedCostOre).toBe(row.fixedCostOre);
    expect(r.fixedCostOre).toBeLessThan(31000);

    // Som skalet skickar filtret: ?automat=…&butik=<automatens butik>. Samma siffror.
    const placed = await one<{ store_id: string }>(
      db(),
      sql`select store_id from public.machine_placements
          where machine_id = ${machineId}::uuid and valid_to is null limit 1`,
    );
    const both = { storeId: placed.store_id, machineId };
    const scoped = await loadDomainInputFor(owner, { period: OCT, ...both }, NOW);
    const r2 = resultAfterProfit({
      current: scoped.current,
      organization: org.current,
      refunds: adj.refunds,
      fixedCosts: adj.fixedCosts,
      scope: both,
    });
    expect(r2.fixedNote).toBeNull();
    expect(r2.refundOre).toBe(r.refundOre);
    expect(r2.fixedCostOre).toBe(r.fixedCostOre);
    expect(r2.resultOre).toBe(r.resultOre);
  });

  it("påfyllaren får inga belopp", async () => {
    await expect(loadProfitAdjustmentsFor(refiller, OCT)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

describe("seeden", () => {
  it("har bankkontot 1930", async () => {
    const row = await one<{ bas: string }>(
      db(),
      sql`select bas_account as bas from public.ledger_accounts
          where organization_id = ${orgId}::uuid and key = 'bank'`,
    );
    expect(row.bas).toBe("1930");
  });
});
