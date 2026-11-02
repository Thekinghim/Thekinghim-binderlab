/**
 * Kom igång mot testdatabasen: status per steg räknad ur datan (RLS, rollen ur
 * databasen), tidpunkter från created_at, täckningen av inköpspriser jämfört med
 * domänlagrets keyMetrics, och vem som får se checklistan.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Tx } from "@/db/client";
import { keyMetrics } from "@/domain";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import { loadDomainInputFor } from "@/server/data/core/loaders";
import { loadOnboardingStatusFor } from "@/server/onboarding/status";
import type { OnboardingStatus } from "@/server/onboarding/model";

import {
  asPostgres,
  asUser,
  createMember,
  createOrg,
  createUser,
  one,
  seedTenantFixture,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const NOW = new Date("2026-11-02T12:00:00Z");

const session = (u: TestUser) => ({ userId: u.id, email: u.email });

function states(s: OnboardingStatus): Record<string, string> {
  return Object.fromEntries(s.steps.map((x) => [x.id, x.state]));
}

function step(s: OnboardingStatus, id: string) {
  const found = s.steps.find((x) => x.id === id);
  if (!found) throw new Error(`Steget ${id} saknas`);
  return found;
}

/**
 * created_at kan inte ändras (private.stamp_update). Testerna som styr tiden stänger av
 * triggrarna i sin egen transaktion, som databasägaren.
 */
async function stampable(tx: Tx): Promise<void> {
  await tx.execute(sql`set local session_replication_role = replica`);
}

async function newOwnerOrg(): Promise<{ owner: TestUser; orgId: string }> {
  const owner = await createUser(`owner-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Kom igång ${uniqueSuffix()}`);
  return { owner, orgId };
}

/** Butik, automat i butiken, datakälla och en import med order för två titlar (79 + 89 kr). */
async function seedOperations(owner: TestUser, orgId: string) {
  return asUser(owner, async (tx) => {
    const store = await one<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name) values (${orgId}, 'ICA Nära') returning id`,
    );
    const machine = await one<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${orgId}, 'BL-001', 'Automat 1', '2025-01-01') returning id`,
    );
    await tx.execute(
      sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
          values (${orgId}, ${machine.id}, ${store.id}, '2025-01-01')`,
    );
    const source = await one<{ id: string }>(
      tx,
      sql`insert into public.data_sources (organization_id, provider, name)
          values (${orgId}, 'awish_csv', 'Awish CSV') returning id`,
    );
    const [a, b] = await Promise.all(
      ["Pokémon 151 Booster", "Surging Sparks Booster"].map((name) =>
        one<{ id: string }>(
          tx,
          sql`insert into public.titles (organization_id, name) values (${orgId}, ${name}) returning id`,
        ),
      ),
    );
    const imp = await one<{ id: string }>(
      tx,
      sql`insert into public.imports (organization_id, data_source_id, trigger, file_name,
            file_sha256, storage_path, parser_version, rows_total, rows_new, status)
          values (${orgId}, ${source.id}, 'upload', 'orders.csv', ${"b".repeat(64)},
            ${`${orgId}/imports/orders.csv`}, 'awish-csv@1', 2, 2, 'succeeded')
          returning id`,
    );
    await tx.execute(
      sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title,
            title_id, ordered_at, amount_ore, payment_method, machine_id, import_id, source_hash)
          values
            (${orgId}, ${source.id}, '1', 'Pokemon 151', ${a!.id}, '2025-03-10T10:00:00Z', 7900,
             'card', ${machine.id}, ${imp.id}, 'h1'),
            (${orgId}, ${source.id}, '2', 'Surging Sparks', ${b!.id}, '2025-03-11T10:00:00Z', 8900,
             'card', ${machine.id}, ${imp.id}, 'h2')`,
    );
    return { storeId: store.id, machineId: machine.id, titleA: a!.id, titleB: b!.id };
  });
}

describe("onboardingStatus: status per steg", () => {
  it("ny organisation: bara organisationen är klar", async () => {
    const { owner, orgId } = await newOwnerOrg();
    const s = await loadOnboardingStatusFor(session(owner), orgId, NOW);
    expect(s.complete).toBe(false);
    expect(states(s)).toEqual({
      organisation: "done",
      butik: "todo",
      avtal: "waiting",
      automat: "todo",
      datakalla: "todo",
      import: "waiting",
      inkopspriser: "waiting",
    });
    expect(s.next?.id).toBe("butik");
    expect(s.coverage.pricedShareBp).toBeNull();
  });

  it("butik, automat, datakälla och order men inga priser: bara inköpspriserna och avtalet kvar", async () => {
    const { owner, orgId } = await newOwnerOrg();
    const ops = await seedOperations(owner, orgId);
    const s = await loadOnboardingStatusFor(session(owner), orgId, NOW);
    expect(states(s)).toEqual({
      organisation: "done",
      butik: "done",
      avtal: "todo",
      automat: "done",
      datakalla: "done",
      import: "done",
      inkopspriser: "todo",
    });
    expect(s.next?.id).toBe("inkopspriser");
    expect(step(s, "automat").detail).toBe("1 automat, 1 placerad i en butik.");
    expect(step(s, "import").detail).toBe("2 order från 1 import.");
    expect(step(s, "avtal").action?.href).toBe(`/butiker/${ops.storeId}#ersattning`);
    expect(s.coverage).toEqual({ revenueOre: 16_800, pricedRevenueOre: 0, pricedShareBp: 0 });
  });

  it("pris för en av två titlar (47 %) räcker inte; med båda är panelen klar", async () => {
    const { owner, orgId } = await newOwnerOrg();
    const ops = await seedOperations(owner, orgId);
    await asUser(owner, (tx) =>
      tx.execute(
        sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
            values (${orgId}, ${ops.titleA}, 4500, '2025-01-01')`,
      ),
    );
    const half = await loadOnboardingStatusFor(session(owner), orgId, NOW);
    expect(half.coverage.pricedShareBp).toBe(4_702);
    expect(step(half, "inkopspriser").state).toBe("todo");
    expect(half.complete).toBe(false);

    const last = await asUser(owner, (tx) =>
      one<{ created_at: Date }>(
        tx,
        sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
            values (${orgId}, ${ops.titleB}, 5200, '2025-01-01') returning created_at`,
      ),
    );
    const done = await loadOnboardingStatusFor(session(owner), orgId, NOW);
    expect(done.complete).toBe(true);
    expect(step(done, "inkopspriser").doneAt).toBe(new Date(last.created_at).toISOString());
    expect(done.completedAt).toBe(step(done, "inkopspriser").doneAt);
  });

  it("en import utan order räknas inte som import med order", async () => {
    const { owner, orgId } = await newOwnerOrg();
    await asUser(owner, async (tx) => {
      const source = await one<{ id: string }>(
        tx,
        sql`insert into public.data_sources (organization_id, provider, name)
            values (${orgId}, 'awish_csv', 'Awish CSV') returning id`,
      );
      await tx.execute(
        sql`insert into public.imports (organization_id, data_source_id, trigger, file_name,
              file_sha256, storage_path, parser_version, rows_total, rows_new, status)
            values (${orgId}, ${source.id}, 'upload', 'tom.csv', ${"c".repeat(64)},
              ${`${orgId}/imports/tom.csv`}, 'awish-csv@1', 0, 0, 'succeeded')`,
      );
    });
    const s = await loadOnboardingStatusFor(session(owner), orgId, NOW);
    expect(step(s, "datakalla").state).toBe("done");
    expect(step(s, "import").state).toBe("todo");
    expect(step(s, "inkopspriser").state).toBe("waiting");
  });

  it("arkiverade butiker och automater räknas inte", async () => {
    const { owner, orgId } = await newOwnerOrg();
    await asUser(owner, (tx) =>
      tx.execute(
        sql`insert into public.stores (organization_id, name, archived_at)
            values (${orgId}, 'Stängd butik', now())`,
      ),
    );
    const s = await loadOnboardingStatusFor(session(owner), orgId, NOW);
    expect(step(s, "butik").state).toBe("todo");
  });

  it("hela fixturen: klar, och täckningen är densamma som domänlagrets keyMetrics", async () => {
    const f = await seedTenantFixture();
    const s = await loadOnboardingStatusFor(session(f.owner), f.orgId, NOW);
    expect(s.complete).toBe(true);
    expect(s.done).toBe(7);

    const user = session(f.owner);
    const organization = (await listOrganizationsFor(user)).find((o) => o.id === f.orgId)!;
    const input = await loadDomainInputFor(
      { user, organization },
      { period: { start: "2000-01-01", end: "2026-11-02" } },
      NOW,
    );
    expect(s.coverage.pricedShareBp).toBe(10_000 - keyMetrics(input.current).unpricedShareBp);
  });
});

describe("onboardingStatus: tid per steg", () => {
  it("räknar tiden från organisationens created_at till varje stegs första rad", async () => {
    const { owner, orgId } = await newOwnerOrg();
    const ops = await seedOperations(owner, orgId);
    const start = new Date("2026-11-02T08:00:00Z");
    const plus = (min: number) => new Date(start.getTime() + min * 60_000).toISOString();
    await asPostgres(async (tx) => {
      await stampable(tx);
      await tx.execute(
        sql`update public.organizations set created_at = ${plus(0)} where id = ${orgId}`,
      );
      await tx.execute(
        sql`update public.stores set created_at = ${plus(5)} where organization_id = ${orgId}`,
      );
      await tx.execute(
        sql`update public.machines set created_at = ${plus(12)} where organization_id = ${orgId}`,
      );
      await tx.execute(
        sql`update public.data_sources set created_at = ${plus(20)} where organization_id = ${orgId}`,
      );
      await tx.execute(
        sql`update public.imports set created_at = ${plus(29)}, started_at = ${plus(29)},
              finished_at = ${plus(30)} where organization_id = ${orgId}`,
      );
    });
    await asUser(owner, (tx) =>
      tx.execute(
        sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
            values (${orgId}, ${ops.titleA}, 4500, '2025-01-01'),
                   (${orgId}, ${ops.titleB}, 5200, '2025-01-01')`,
      ),
    );
    await asPostgres(async (tx) => {
      await stampable(tx);
      await tx.execute(
        sql`update public.purchase_prices set created_at = ${plus(45)} where organization_id = ${orgId}`,
      );
    });

    const s = await loadOnboardingStatusFor(session(owner), orgId, NOW);
    expect(s.startedAt).toBe(plus(0));
    expect(step(s, "butik").sinceStartMs).toBe(5 * 60_000);
    expect(step(s, "automat").sinceStartMs).toBe(12 * 60_000);
    expect(step(s, "datakalla").sinceStartMs).toBe(20 * 60_000);
    expect(step(s, "import").doneAt).toBe(plus(30));
    expect(step(s, "inkopspriser").doneAt).toBe(plus(45));
    expect(s.complete).toBe(true);
    expect(s.elapsedMs).toBe(45 * 60_000);
  });

  it("pågående onboarding: tiden räknas till nu", async () => {
    const { owner, orgId } = await newOwnerOrg();
    await asPostgres(async (tx) => {
      await stampable(tx);
      await tx.execute(
        sql`update public.organizations set created_at = '2026-11-02T11:00:00Z' where id = ${orgId}`,
      );
    });
    const s = await loadOnboardingStatusFor(session(owner), orgId, NOW);
    expect(s.complete).toBe(false);
    expect(s.elapsedMs).toBe(60 * 60_000);
  });
});

describe("onboardingStatus: behörighet", () => {
  it("ägare, admin och läsare ser checklistan", async () => {
    const { orgId } = await newOwnerOrg();
    for (const role of ["admin", "viewer"] as const) {
      const member = await createMember(orgId, role);
      const s = await loadOnboardingStatusFor(session(member), orgId, NOW);
      expect(s.organizationId).toBe(orgId);
    }
  });

  it("påfyllaren nekas (checklistan räknar på intäkten)", async () => {
    const { orgId } = await newOwnerOrg();
    const refiller = await createMember(orgId, "refiller");
    await expect(loadOnboardingStatusFor(session(refiller), orgId, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("en annan organisations ägare nekas, och ogiltigt id nekas", async () => {
    const { orgId } = await newOwnerOrg();
    const other = await newOwnerOrg();
    await expect(loadOnboardingStatusFor(session(other.owner), orgId, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      loadOnboardingStatusFor(session(other.owner), "inte-ett-id", NOW),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
