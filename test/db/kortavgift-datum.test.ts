/**
 * Kortavgiften gäller från ett datum (testdatabasen, egen fixtur, "i dag" 19 nov. 2026).
 *
 * Oktober är betald och stängd med 0 % kortavgift. Sedan ändras avgiften till 4,0 %:
 * - förvalet är första dagen som inte är låst (1 nov.), och oktober räknas som förut
 * - en ändring som når in i oktober nekas, med ett besked på enkel svenska
 * - den gamla kodens skrivning (bara card_fee_bp) nekas också när en månad är stängd,
 *   och gäller alla datum när ingen är det
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

import { updateSettingsFor } from "@/app/(app)/installningar/_lib/data";
import { withUserDbFor } from "@/server/access";
import { querySettings } from "@/server/data/core/queries";
import { loadFirstOpenDayFor } from "@/server/periods/service";
import { computeSettlementsTx } from "@/server/settlements/live";
import { ensureSettlementsFor, markSettlementPaidFor } from "@/server/settlements/service";

import { asPostgres, asUser, attempt, one } from "./helpers";
import { seedMoneyFixture, settlementId, type MoneyFixture } from "./pengar-fixture";

const NOW = new Date("2026-11-19T10:00:00Z");
const TODAY = "2026-11-19";

let f: MoneyFixture;

const share = async (month: "2026-10" | "2026-11") => {
  const live = await withUserDbFor(f.owner.user, (tx) =>
    computeSettlementsTx(tx, {
      organizationId: f.orgId,
      month,
      storeIds: [f.stores.vinsten],
      now: NOW,
    }),
  );
  const s = live.get(f.stores.vinsten)!;
  if (!s.ok) throw new Error(s.message);
  return s.computed.amountOre;
};

const base = () => ({ organizationId: f.orgId, vatRateBp: 0, fiscalYearStartMonth: 1 });

beforeAll(async () => {
  f = await seedMoneyFixture("Kortavgift");
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await f.order("m1", "2026-11-05", 10_000);
  await asPostgres((tx) =>
    tx.execute(
      sql`insert into public.organization_settings (organization_id) values (${f.orgId})
          on conflict (organization_id) do nothing`,
    ),
  );
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

describe("kortavgiften från ett datum", () => {
  it("utgångsläget: 0 %, inget är låst, oktober ger butiken 60 kr", async () => {
    // Oktober: 200 kr sålt, 80 kr inköp, 0 kr avgift → vinst 120 kr → 50 % = 60 kr.
    expect(await share("2026-10")).toBe(6_000);
    expect(await loadFirstOpenDayFor(f.owner)).toBeNull();
  });

  it("efter betald oktober är förvalet 1 november, och oktober räknas som förut", async () => {
    await ensureSettlementsFor(f.owner, NOW);
    for (const store of [f.stores.vinsten, f.stores.provision]) {
      await markSettlementPaidFor(
        f.owner,
        await settlementId(f.orgId, store, "2026-10"),
        TODAY,
        null,
        NOW,
      );
    }
    expect(await loadFirstOpenDayFor(f.owner)).toBe("2026-11-01");

    const saved = await updateSettingsFor(f.owner.user, { ...base(), cardFeeBp: 400 });
    expect(saved).toEqual({ ok: true, data: { changed: true, cardFeeFrom: "2026-11-01" } });

    const settings = await withUserDbFor(f.owner.user, (tx) => querySettings(tx, f.orgId));
    expect(settings.cardFeeBp).toBe(400);
    expect(settings.cardFeeRates).toEqual([
      { validFrom: "2000-01-01", cardFeeBp: 0 },
      { validFrom: "2026-11-01", cardFeeBp: 400 },
    ]);
    // Oktober: som förut. Med en sats för alla datum hade det blivit 56 kr.
    expect(await share("2026-10")).toBe(6_000);
    // November: 100 kr sålt, 40 kr inköp, 4 kr avgift → vinst 56 kr → 28 kr.
    expect(await share("2026-11")).toBe(2_800);
  });

  it("ändringen loggas", async () => {
    const log = await asPostgres((tx) =>
      one<{ n: number }>(
        tx,
        sql`select count(*)::int as n from public.audit_log
            where organization_id = ${f.orgId} and table_name = 'organization_settings'
              and action = 'update' and after ->> 'card_fee_bp' = '400'
              and after -> 'card_fee_history' -> 1 ->> 'from' = '2026-11-01'`,
      ),
    );
    expect(log.n).toBe(1);
  });

  it("en ändring som når in i den stängda månaden nekas, på enkel svenska", async () => {
    for (const cardFeeFrom of ["2026-10-01", null]) {
      const r = await updateSettingsFor(f.owner.user, { ...base(), cardFeeBp: 300, cardFeeFrom });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe(
          "Oktober 2026 är stängd. Kortavgiften kan inte ändras där. Ägaren kan öppna månaden igen under Butiker → Utbetalning.",
        );
      }
    }
    expect(await share("2026-10")).toBe(6_000);
  });

  it("ett datum i framtiden nekas", async () => {
    const r = await updateSettingsFor(f.owner.user, {
      ...base(),
      cardFeeBp: 300,
      cardFeeFrom: "2026-12-01",
    });
    expect(r).toEqual({ ok: false, error: "Kortavgiften kan inte börja gälla i framtiden." });
  });

  it("den gamla kodens skrivning (bara card_fee_bp) nekas när en månad är stängd", async () => {
    const r = await asUser(f.ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.organization_settings set card_fee_bp = 250
              where organization_id = ${f.orgId}`,
        ),
      ),
    );
    expect(r.code).toBe("BL004");
  });

  it("en ogiltig lista nekas av databasen", async () => {
    const r = await asUser(f.ownerUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.organization_settings
              set card_fee_history = '[{"from":"2026-11-01","bp":1},{"from":"2026-11-01","bp":2}]'::jsonb
              where organization_id = ${f.orgId}`,
        ),
      ),
    );
    expect(r.code).toBe("22023");
  });
});

describe("utan stängda månader", () => {
  it("den gamla kodens skrivning gäller alla datum och tömmer listan", async () => {
    const g = await seedMoneyFixture("Kortavgift gammal kod");
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.organization_settings
            set card_fee_bp = 400,
                card_fee_history = '[{"from":"2000-01-01","bp":0},{"from":"2026-11-01","bp":400}]'::jsonb
            where organization_id = ${g.orgId}`,
      ),
    );
    await asUser(g.ownerUser, (tx) =>
      tx.execute(
        sql`update public.organization_settings set card_fee_bp = 250
            where organization_id = ${g.orgId}`,
      ),
    );
    const settings = await withUserDbFor(g.owner.user, (tx) => querySettings(tx, g.orgId));
    expect(settings).toMatchObject({ cardFeeBp: 250 });
    expect(settings.cardFeeRates).toBeUndefined();
  });

  it("null = all försäljning, och svaret säger det", async () => {
    const g = await seedMoneyFixture("Kortavgift allt");
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.organization_settings (organization_id) values (${g.orgId})
                     on conflict (organization_id) do nothing`),
    );
    // Inget är låst: förvalet är all försäljning.
    const r = await updateSettingsFor(g.owner.user, {
      organizationId: g.orgId,
      vatRateBp: 0,
      fiscalYearStartMonth: 1,
      cardFeeBp: 400,
    });
    expect(r).toEqual({ ok: true, data: { changed: true, cardFeeFrom: null } });
    const settings = await withUserDbFor(g.owner.user, (tx) => querySettings(tx, g.orgId));
    expect(settings.cardFeeBp).toBe(400);
    expect(settings.cardFeeRates).toBeUndefined();
  });
});
