/**
 * Pengar → "Vem pengarna är till" mot databasen (src/server/payouts/period-split.ts).
 *
 * Fixturen (pengar-fixture.ts): Vinsten 50 % av vinsten (BL-001), Provision 10 % av
 * försäljningen (BL-002), packet kostar 40 kr. Oktober: 200 kr hos Vinsten, 300 kr hos
 * Provision.
 *
 * - Raderna summerar exakt till försäljningen, Min andel först.
 * - Utan partneravtal: partnern får 0 och raden säger det.
 * - Två butiker i samma bolag blir en rad med bolagets namn.
 * - Samma belopp som Utbetalningar räknar för en utbetalning som täcker samma dagar.
 * - Bara ägare och admin (läsaren och påfyllaren nekas).
 */

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

import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import { loadPeriodSplitFor } from "@/server/payouts/period-split";
import {
  expectedForPeriodFor,
  loadPayoutsPageFor,
  registerPayoutFor,
  savePartnerAgreementFor,
  savePayoutOptionsFor,
} from "@/server/payouts/service";

import { asPostgres, createMember, one, type TestUser } from "./helpers";
import { seedMoneyFixture, type MoneyFixture } from "./pengar-fixture";

const NOW = new Date("2026-11-15T10:00:00Z");
const OCTOBER = { start: "2026-10-01", end: "2026-10-31" } as const;

let f: MoneyFixture;

async function viewerOf(u: TestUser) {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === f.orgId)!;
  return { user, organization };
}

beforeAll(async () => {
  f = await seedMoneyFixture("Fördelning");
});

describe("Vem pengarna är till", () => {
  it("utan partneravtal: raderna summerar till försäljningen, partnern får 0", async () => {
    const v = await loadPeriodSplitFor(f.owner, OCTOBER, NOW);
    expect(v.basisOre).toBe(50_000);
    expect(v.rows[0]!.kind).toBe("owner");
    expect(v.rows.reduce((a, r) => a + r.amountOre, 0)).toBe(50_000);
    expect(v.rows.reduce((a, r) => a + r.displayOre, 0)).toBe(50_000);
    const partner = v.rows.find((r) => r.kind === "partner")!;
    expect(partner).toMatchObject({ label: "Partner", amountOre: 0 });
    expect(partner.partner?.hasAgreement).toBe(false);
    expect(
      v.rows
        .filter((r) => r.kind === "store")
        .map((r) => r.label)
        .sort(),
    ).toEqual(["Provision", "Vinsten"]);
    // Provision: 10 % av försäljningen (300 kr) = 30 kr, som avräkningen.
    expect(v.rows.find((r) => r.label === "Provision")!.amountOre).toBe(3_000);
  });

  it("ingen försäljning: tomt", async () => {
    const v = await loadPeriodSplitFor(f.owner, { start: "2026-11-01", end: "2026-11-14" }, NOW);
    expect(v.empty).toBe(true);
  });

  it("bolaget är en rad, och beloppen är desamma som Utbetalningar räknar", async () => {
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
    const company = await asPostgres(async (tx) => {
      const o = await one<{ id: string }>(
        tx,
        sql`insert into public.store_owners (organization_id, legal_name, org_number)
            values (${f.orgId}::uuid, 'Testbolaget AB', '559900-1236') returning id`,
      );
      await tx.execute(
        sql`update public.stores set owner_id = ${o.id}::uuid
            where organization_id = ${f.orgId}::uuid`,
      );
      return o.id;
    });

    const v = await loadPeriodSplitFor(f.admin, OCTOBER, NOW);
    expect(v.rows.reduce((a, r) => a + r.amountOre, 0)).toBe(50_000);
    const co = v.rows.filter((r) => r.kind === "store_owner");
    expect(co).toHaveLength(1);
    expect(co[0]!.key).toBe(`store_owner:${company}`);
    expect(co[0]!.label).toBe("Testbolaget AB");
    expect(co[0]!.stores!.map((s) => s.name).sort()).toEqual(["Provision", "Vinsten"]);
    expect(v.rows.some((r) => r.kind === "store")).toBe(false);
    const partner = v.rows.find((r) => r.kind === "partner")!;
    expect(partner.label).toBe("Partner X");
    // Inköpet tillbaka: tre pack à 40 kr.
    expect(partner.partner).toMatchObject({ hasAgreement: true, reimbOre: 12_000, bp: 5_000 });

    // En utbetalning från Nayax för samma dagar med det belopp vi väntar oss.
    const expected = await expectedForPeriodFor(f.owner, OCTOBER);
    const r = await registerPayoutFor(
      f.owner,
      { paidOn: "2026-11-02", amountOre: expected.netOre, period: OCTOBER },
      NOW,
      { summaryWriter: null },
    );
    const page = await loadPayoutsPageFor(f.owner, NOW, { payoutId: r.payoutId });
    const lines = page.payouts[0]!.lines;
    const line = (kind: string) => lines.find((l) => l.kind === kind)?.amountOre ?? 0;
    const row = (kind: string) => v.rows.find((x) => x.kind === kind)?.amountOre ?? 0;
    expect(row("store_owner")).toBe(line("store_owner"));
    expect(row("partner")).toBe(line("partner"));
    expect(row("vat")).toBe(line("vat_reserve"));
    expect(row("owner")).toBe(line("owner") - expected.refundsOre);
    expect(row("fees")).toBe(expected.feeOre);
  });

  it("bara ägare och admin", async () => {
    for (const role of ["viewer", "refiller"] as const) {
      const u = await createMember(f.orgId, role);
      await expect(loadPeriodSplitFor(await viewerOf(u), OCTOBER, NOW)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    }
  });
});
