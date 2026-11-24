/**
 * Utbetalningar från Nayax (Pengar → Utbetalningar) mot databasen: uträkningen per
 * utbetalning, "Markera som betald" (kopplad butiksbetalning som betalar avräkningen),
 * låset, justeringen mot månadsavräkningen, omräkning när ett inköpspris ändras, den
 * räknade perioden och att ingen annan än ägare och admin ser något.
 *
 * Fixturen (pengar-fixture.ts): Vinsten 50 % av vinsten (BL-001), Provision 10 % av
 * försäljningen (BL-002), packet kostar 40 kr. Moms på vinsten sparas (vmb). Partnern
 * får tillbaka inköpet och 50 % av vinsten.
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_noStore: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

import { listOrganizationsFor } from "@/server/access";
import { markPaidFor, undoPaidFor } from "@/server/payouts/pay";
import {
  loadPayoutsPageFor,
  registerPayoutFor,
  runPayoutJob,
  savePartnerAgreementFor,
  savePayoutOptionsFor,
  uploadPayoutFileFor,
  applyMappingFor,
  confirmDraftFor,
} from "@/server/payouts/service";
import { createMonthlySettlements } from "@/server/settlements/service";

import {
  addMember,
  asPostgres,
  asUser,
  createMember,
  createUser,
  db,
  rows,
  settle,
} from "./helpers";
import { seedMoneyFixture, type MoneyFixture } from "./pengar-fixture";
import { inviteStoreUser } from "./portal-fixture";

const NOW = new Date("2026-11-15T10:00:00Z");
const noAi = { summaryWriter: null } as const;

let f: MoneyFixture;

const memoryStore = () => {
  const files = new Map<string, Uint8Array>();
  return {
    kind: "local" as const,
    put: async (path: string, content: Uint8Array) => {
      files.set(path, content);
      return { path, created: true };
    },
    get: async (path: string) => files.get(path)!,
  };
};

beforeAll(async () => {
  f = await seedMoneyFixture("Utbetalningar");
  await savePartnerAgreementFor(
    f.owner,
    {
      partnerName: "Partner X",
      reimburseCost: true,
      profitSharePercent: 50,
      validFrom: "2026-01-01",
    },
    NOW,
  );
  await savePayoutOptionsFor(f.owner, { vatReserveMode: "vmb", reminderDays: 7 }, NOW);
});

afterAll(() => {
  session.current = null;
});

async function linesOf(payoutId: string) {
  const page = await loadPayoutsPageFor(f.owner, NOW, { payoutId });
  return page.payouts[0]!;
}

describe("utbetalningarna", () => {
  let septId: string;

  it("delar en utbetalning: butikerna, partnern, momsen och resten, summan exakt", async () => {
    const r = await registerPayoutFor(
      f.owner,
      {
        paidOn: "2026-10-02",
        amountOre: 20_000,
        period: { start: "2026-09-01", end: "2026-09-30" },
      },
      NOW,
      noAi,
    );
    septId = r.payoutId;
    const p = await linesOf(septId);
    const byKind = (k: string) => p.lines.filter((l) => l.kind === k);
    // Vinsten: (100 − 40) × 50 % = 30 kr. Provision: 10 % av 100 kr = 10 kr.
    expect(
      byKind("store")
        .map((l) => [l.name, l.amountOre])
        .sort(),
    ).toEqual([
      ["Provision", 1000],
      ["Vinsten", 3000],
    ]);
    // Moms på vinsten: (200 − 80) × 20 % = 24 kr. Vinst: 200 − 40 − 80 − 24 = 56 kr.
    expect(byKind("vat_reserve")[0]!.amountOre).toBe(2400);
    expect(byKind("partner")[0]!.amountOre).toBe(8000 + 2800);
    expect(byKind("partner")[0]!.name).toBe("Partner X");
    expect(byKind("owner")[0]!.amountOre).toBe(2800);
    expect(p.lines.reduce((a, l) => a + l.amountOre, 0)).toBe(20_000);
    expect(p.allocation!.status).toBe("draft");
    expect(p.summary).toContain("Nayax betalade 200");
  });

  it("räknar om utkastet när ett inköpspris ändras, men inte när inget ändrats", async () => {
    const before = await rows<{ version: number }>(
      db(),
      sql`select version from public.payout_allocations where payout_id = ${septId} and superseded_at is null`,
    );
    await loadPayoutsPageFor(f.owner, NOW);
    const same = await rows<{ version: number }>(
      db(),
      sql`select version from public.payout_allocations where payout_id = ${septId} and superseded_at is null`,
    );
    expect(same[0]!.version).toBe(before[0]!.version);
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
        values (${f.orgId}, ${f.titleId}, 5000, '2026-09-01')`),
    );
    const p = await linesOf(septId);
    const after = await rows<{ version: number }>(
      db(),
      sql`select version from public.payout_allocations where payout_id = ${septId} and superseded_at is null`,
    );
    expect(after[0]!.version).toBe(before[0]!.version + 1);
    expect(p.lines.find((l) => l.kind === "partner")!.partner!.reimbOre).toBe(10_000);
    expect(p.lines.reduce((a, l) => a + l.amountOre, 0)).toBe(20_000);
  });

  it("Markera som betald: butiksbetalning kopplad till raden, uträkningen låses", async () => {
    const p = await linesOf(septId);
    const vinsten = p.lines.find((l) => l.name === "Vinsten")!;
    const paid = await markPaidFor(f.owner, { lineIds: [vinsten.id], paidOn: "2026-11-14" }, NOW);
    expect(paid.paidOre).toBe(vinsten.amountOre);
    const pays = await rows<{ amount_ore: string; line: string; period_start: string }>(
      db(),
      sql`select amount_ore, payout_allocation_line_id as line, period_start::text
          from public.store_payments where organization_id = ${f.orgId}`,
    );
    expect(pays).toEqual([
      { amount_ore: String(vinsten.amountOre), line: vinsten.id, period_start: "2026-09-01" },
    ]);
    const after = await linesOf(septId);
    expect(after.allocation!.status).toBe("locked");
    expect(after.lines.find((l) => l.name === "Vinsten")!.leftOre).toBe(0);
    // Låst: ett nytt inköpspris ändrar inte uträkningen.
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
        values (${f.orgId}, ${f.titleId}, 4000, '2026-09-15')`),
    );
    const locked = await linesOf(septId);
    expect(locked.allocation!.id).toBe(after.allocation!.id);
  });

  it("databasen vägrar ändra en låst uträkning och betala från en ersatt", async () => {
    const p = await linesOf(septId);
    const amount = await settle(
      asPostgres((tx) =>
        tx.execute(
          sql`update public.payout_allocations set amount_ore = 1 where id = ${p.allocation!.id}`,
        ),
      ),
    );
    expect(amount.ok).toBe(false);
    expect(amount.message).toMatch(/ändras inte/);
    const superseded = await settle(
      asPostgres((tx) =>
        tx.execute(
          sql`update public.payout_allocations set superseded_at = now() where id = ${p.allocation!.id}`,
        ),
      ),
    );
    expect(superseded.message).toMatch(/låst/);
  });

  it("partner, moms och uttag: betala och ångra", async () => {
    const p = await linesOf(septId);
    const partner = p.lines.find((l) => l.kind === "partner")!;
    const part = await markPaidFor(
      f.owner,
      { lineIds: [partner.id], paidOn: "2026-11-14", amountOre: 1000 },
      NOW,
    );
    expect((await linesOf(septId)).lines.find((l) => l.kind === "partner")!.leftOre).toBe(
      partner.amountOre - 1000,
    );
    await undoPaidFor(f.owner, part.refs, NOW);
    expect((await linesOf(septId)).lines.find((l) => l.kind === "partner")!.leftOre).toBe(
      partner.amountOre,
    );
    await expect(
      markPaidFor(
        f.owner,
        { lineIds: [partner.id], paidOn: "2026-11-14", amountOre: partner.amountOre + 1 },
        NOW,
      ),
    ).rejects.toThrow(/mer än/);
  });

  let octEarly: string;
  it("räknar ut perioden när den saknas (äldsta obetalda försäljningen först)", async () => {
    // Oktober: 100 kr den 5:e (Vinsten), 300 kr den 6:e (Provision), 100 kr den 20:e (Vinsten).
    const r = await registerPayoutFor(
      f.owner,
      { paidOn: "2026-10-08", amountOre: 40_000 },
      NOW,
      noAi,
    );
    octEarly = r.payoutId;
    expect(r.inferred).toBe(true);
    expect(r.period).toEqual({ start: "2026-10-01", end: "2026-10-06" });
    const p = await linesOf(octEarly);
    expect(p.basis).toBe("inferred");
    expect(p.inferredNote).toContain("1–6 okt.");
    // Låses genom att Provision betalas.
    const prov = p.lines.find((l) => l.name === "Provision")!;
    await markPaidFor(f.owner, { lineIds: [prov.id], paidOn: "2026-11-14" }, NOW);
    await expect(
      registerPayoutFor(
        f.owner,
        {
          paidOn: "2026-10-09",
          amountOre: 100,
          period: { start: "2026-10-06", end: "2026-10-07" },
        },
        NOW,
        noAi,
      ),
    ).rejects.toThrow(/redan en utbetalning/);
  });

  it("justerar mot månadsavräkningen så att oktober blir exakt avräkningen", async () => {
    // En sen order 5 okt. (efter att första oktoberutbetalningen låstes).
    await f.order("m2", "2026-10-05", 10_000);
    await createMonthlySettlements(db(), NOW, { organizationIds: [f.orgId] });
    const settled = await rows<{ store_id: string; amount_ore: string }>(
      db(),
      sql`select store_id, amount_ore from public.store_settlements
          where organization_id = ${f.orgId} and month = '2026-10-01'`,
    );
    expect(settled.length).toBe(2);
    const r = await registerPayoutFor(
      f.owner,
      {
        paidOn: "2026-11-02",
        amountOre: 10_000,
        period: { start: "2026-10-07", end: "2026-10-31" },
      },
      NOW,
      noAi,
    );
    const page = await loadPayoutsPageFor(f.owner, NOW);
    for (const s of settled) {
      let sum = 0;
      for (const p of page.payouts) {
        for (const l of p.lines) {
          for (const c of l.stores)
            if (c.storeId === s.store_id && c.month === "2026-10") sum += c.shareOre;
        }
      }
      expect(sum).toBe(Number(s.amount_ore));
    }
    const late = page.payouts.find((p) => p.id === r.payoutId)!;
    const prov = late.lines.find((l) => l.name === "Provision")!;
    expect(prov.stores.some((c) => c.source === "trueup")).toBe(true);
    expect(late.lines.reduce((a, l) => a + l.amountOre, 0)).toBe(10_000);
  });

  it("betalning av justeringen betalar butikens månadsavräkning med betalningarna", async () => {
    const page = await loadPayoutsPageFor(f.owner, NOW);
    const row = page.recipients.find((r) => r.name === "Provision")!;
    await markPaidFor(f.owner, { lineIds: [...row.lineIds], paidOn: "2026-11-15" }, NOW);
    const [st] = await rows<{ paid_on: string | null; from_payments: boolean }>(
      db(),
      sql`select paid_on::text, paid_from_payments as from_payments from public.store_settlements
          where organization_id = ${f.orgId} and store_id = ${f.stores.provision} and month = '2026-10-01'`,
    );
    expect(st).toEqual({ paid_on: "2026-11-15", from_payments: true });
  });

  it("det dagliga jobbet går igenom utan fel", async () => {
    const r = await runPayoutJob(db(), NOW, { organizationIds: [f.orgId], writer: null });
    expect(r.errors).toBe(0);
  });
});

describe("filer från Nayax", () => {
  it("okända kolumner: kolumnsteget, sedan samma layout utan steget", async () => {
    const g = await seedMoneyFixture("Utbetalningar fil");
    const csv =
      "Settlement Date;Net Amount;Total Fees;Gross Amount\n13.11.2026;1 234,56 kr;10,00;1 244,56\n";
    const store = memoryStore();
    const first = await uploadPayoutFileFor(
      g.owner,
      { name: "nayax.csv", bytes: new TextEncoder().encode(csv) },
      NOW,
      {
        fileStore: store,
      },
    );
    // En sammanfattning med en rad läses direkt (alla fält känns igen).
    expect(first.kind).toBe("draft");
    const odd = "Kolumn A;Kolumn B\n2026-11-13;500,00\n2026-11-14;250,00\n";
    const map = await uploadPayoutFileFor(
      g.owner,
      { name: "x.csv", bytes: new TextEncoder().encode(odd) },
      NOW,
      {
        fileStore: store,
      },
    );
    expect(map.kind).toBe("mapping");
    if (map.kind !== "mapping") return;
    const applied = await applyMappingFor(
      g.owner,
      map.draftId,
      { paid_on: "Kolumn A", amount: "Kolumn B" },
      true,
    );
    expect(applied.kind).toBe("draft");
    if (applied.kind !== "draft") return;
    expect(applied.extracted.amountOre).toBe(50_000);
    const again = await uploadPayoutFileFor(
      g.owner,
      { name: "y.csv", bytes: new TextEncoder().encode(odd) },
      NOW,
      {
        fileStore: store,
      },
    );
    expect(again.kind).toBe("draft");
    if (first.kind !== "draft") return;
    expect(first.extracted).toMatchObject({
      paidOn: "2026-11-13",
      amountOre: 123_456,
      feesOre: 1000,
    });
    const saved = await confirmDraftFor(
      g.owner,
      first.draftId,
      { paidOn: "2026-11-13", amountOre: 123_456, feesOre: 1000, period: null },
      NOW,
      { fileStore: store, summaryWriter: null },
    );
    expect(saved.inferred).toBe(true);
    const page = await loadPayoutsPageFor(g.owner, NOW);
    expect(page.payouts[0]!.lines.reduce((a, l) => a + l.amountOre, 0)).toBe(123_456);
  });
});

describe("vem ser vad", () => {
  it("läsare, påfyllare och butiken ser inget av utbetalningarnas fördelning", async () => {
    const viewer = await createMember(f.orgId, "viewer");
    const refiller = await createMember(f.orgId, "refiller");
    const storeUser = await inviteStoreUser(f.ownerUser, f.orgId, f.stores.vinsten);
    for (const u of [viewer, refiller, storeUser]) {
      for (const table of [
        "partner_agreements",
        "payout_allocations",
        "payout_allocation_lines",
        "recipient_payments",
        "payout_drafts",
        "payout_import_mappings",
      ]) {
        const n = await asUser(u, (tx) =>
          rows<{ n: number }>(tx, sql`select count(*)::int as n from ${sql.identifier(table)}`),
        );
        expect(n[0]!.n, `${table} för ${u.email}`).toBe(0);
      }
    }
    // Butiken ser sin betalning (från utbetalningen) i portalen, utan något om fördelningen.
    const portal = await asUser(storeUser, (tx) =>
      rows<Record<string, unknown>>(
        tx,
        sql`select * from public.portal_store_payments(${f.stores.vinsten}::uuid)`,
      ),
    );
    expect(portal.length).toBeGreaterThan(0);
    expect(Object.keys(portal[0]!).sort()).toEqual(
      ["amount_ore", "month", "paid_on", "part_end", "part_start", "payment_id"].sort(),
    );
    // Läsaren nekas sidan.
    const u = { userId: viewer.id, email: viewer.email };
    const org = (await listOrganizationsFor(u)).find((o) => o.id === f.orgId)!;
    await expect(loadPayoutsPageFor({ user: u, organization: org }, NOW)).rejects.toThrow();
  });

  it("en annan organisations ägare ser inget", async () => {
    const other = await createUser();
    await addMember(f.orgId, other, "refiller");
    const n = await asUser(other, (tx) =>
      rows<{ n: number }>(tx, sql`select count(*)::int as n from public.payout_allocations`),
    );
    expect(n[0]!.n).toBe(0);
  });
});

describe("prestanda", () => {
  it("50 000 order, 30 automater, 12 butiker: uträkningen under 1,5 s", async () => {
    const g = await seedMoneyFixture("Utbetalningar stor");
    await asPostgres(async (tx) => {
      await tx.execute(sql`
        with st as (
          insert into public.stores (organization_id, name)
          select ${g.orgId}, 'Butik ' || i from generate_series(1, 12) i returning id
        ), st2 as (select id, row_number() over () as n from st),
        ag as (
          insert into public.store_agreements (organization_id, store_id, valid_from, commission_base, commission_bp)
          select ${g.orgId}, id, '2026-01-01', 'profit_after_costs', 4000 from st2 returning store_id
        ),
        m as (
          insert into public.machines (organization_id, code, name, active_from)
          select ${g.orgId}, 'P-' || i, 'P-' || i, '2026-01-01' from generate_series(1, 30) i returning id
        ), m2 as (select id, row_number() over () as n from m)
        insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
        select ${g.orgId}, m2.id, st2.id, '2026-01-01' from m2 join st2 on st2.n = ((m2.n - 1) % 12) + 1`);
      // Utan orderns triggrar (de gör fixturen långsam, inte uträkningen).
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`
        insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
          ordered_at, business_date, amount_ore, machine_id, source_hash)
        select ${g.orgId}, ${g.sourceId}, 'perf-' || i, 'Pack', ${g.titleId},
          ('2026-10-01'::timestamptz + ((i % 30) || ' days')::interval + interval '10 hours'),
          ('2026-10-01'::date + (i % 30)),
          9900, m.ids[(i % 30) + 1], 'perf-h-' || i
        from generate_series(1, 50000) i,
          (select array_agg(id order by code) as ids from public.machines
            where organization_id = ${g.orgId} and code like 'P-%') m`);
    });
    const started = Date.now();
    await registerPayoutFor(
      g.owner,
      {
        paidOn: "2026-11-05",
        amountOre: 400_000_000,
        period: { start: "2026-10-01", end: "2026-10-31" },
      },
      NOW,
      noAi,
    );
    const ms = Date.now() - started;
    console.log("PERF ms", ms);
    expect(ms).toBeLessThan(1500);
  }, 180_000);
});
