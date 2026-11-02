/**
 * Ändringslogg och append-only.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "../../src/db/client";
import * as s from "../../src/db/schema";
import {
  affected,
  asPostgres,
  asServiceRole,
  asUser,
  attempt,
  createMember,
  db,
  one,
  rel,
  rollback,
  rows,
  sampleRow,
  seedTenantFixture,
  type TenantFixture,
} from "./helpers";

const APPEND_ONLY = ["audit_log", "import_rows", "report_deliveries", "stock_events"] as const;

let F: TenantFixture;

beforeAll(async () => {
  F = await seedTenantFixture();
});

describe("ändringsloggen", () => {
  it("en prisändring ger en rad med före, efter och aktör", async () => {
    await asUser(F.owner, (tx) =>
      tx.execute(
        sql`update public.purchase_prices set unit_cost_ore = 4700 where id = ${F.priceId}`,
      ),
    );
    const entry = await one<{
      action: string;
      actor_id: string;
      before: { unit_cost_ore: number };
      after: { unit_cost_ore: number };
    }>(
      db(),
      sql`select action, actor_id, before, after from public.audit_log
          where organization_id = ${F.orgId} and table_name = 'purchase_prices' and row_id = ${F.priceId}
            and action = 'update'`,
    );
    expect(entry.action).toBe("update");
    expect(entry.actor_id).toBe(F.owner.id);
    expect(entry.before.unit_cost_ore).toBe(4500);
    expect(entry.after.unit_cost_ore).toBe(4700);
  });

  it("en uppdatering utan ändring loggas inte", async () => {
    const count = async () =>
      (
        await one<{ n: number }>(
          db(),
          sql`select count(*)::int as n from public.audit_log where row_id = ${F.priceId}`,
        )
      ).n;
    const before = await count();
    await asUser(F.owner, (tx) =>
      tx.execute(sql`update public.purchase_prices set note = note where id = ${F.priceId}`),
    );
    expect(await count()).toBe(before);
  });

  it("inbjudningar loggas utan token_hash", async () => {
    const entries = await rows<{ after: Record<string, unknown> }>(
      db(),
      sql`select after from public.audit_log where organization_id = ${F.orgId} and table_name = 'invitations'`,
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => !("token_hash" in e.after))).toBe(true);
  });

  it("loggar de tabeller dokumentet kräver", async () => {
    const logged = await rows<{ table_name: string }>(
      db(),
      sql`select distinct table_name from public.audit_log where organization_id = ${F.orgId}`,
    );
    const names = logged.map((r) => r.table_name);
    for (const table of [
      "purchase_prices",
      "stock_events",
      "store_agreements",
      "machine_placements",
      "organization_settings",
      "owner_shares",
      "ledger_accounts",
      "memberships",
      "invitations",
      "title_aliases",
      "titles",
      "report_deliveries",
      "period_closes",
    ]) {
      expect(names, table).toContain(table);
    }
  });

  it("ingen roll kan skriva, ändra eller radera i audit_log (inte ens ägaren)", async () => {
    const row = await sampleRow("audit_log", F.orgId);
    const insert = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into public.audit_log (organization_id, table_name, row_id, action, after)
                       values (${F.orgId}, 'x', ${randomUUID()}, 'insert', '{}'::jsonb)`),
      ),
    );
    expect(insert.code).toBe("42501");
    const runners: Array<<T>(fn: (tx: Tx) => Promise<T>) => Promise<T>> = [
      (fn) => asUser(F.owner, fn),
      (fn) => asServiceRole(fn),
    ];
    for (const run of runners) {
      const update = await run((tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`update public.audit_log set after = '{}'::jsonb where id = ${row!.id as string}`,
          ),
        ),
      );
      expect(update.code).toBe("42501");
      const del = await run((tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`delete from public.audit_log where id = ${row!.id as string}`),
        ),
      );
      expect(del.code).toBe("42501");
    }
  });
});

describe("append-only-tabeller nekar update och delete", () => {
  it.each(APPEND_ONLY)("%s: ägaren saknar rättigheter", async (table) => {
    const row = await sampleRow(table, F.orgId);
    const column = table === "audit_log" ? sql`occurred_at` : sql`created_at`;
    const update = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update ${rel(table)} set ${column} = ${column} where id = ${row!.id as string}`,
        ),
      ),
    );
    expect(update.code).toBe("42501");
    const del = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`delete from ${rel(table)} where id = ${row!.id as string}`),
      ),
    );
    expect(del.code).toBe("42501");
  });

  it.each(APPEND_ONLY.filter((t) => t !== "audit_log"))(
    "%s: service_role stoppas av triggern",
    async (table) => {
      const row = await sampleRow(table, F.orgId);
      const update = await asServiceRole((tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`update ${rel(table)} set created_at = now() where id = ${row!.id as string}`,
          ),
        ),
      );
      expect(update.code).toBe("BL002");
      const del = await asServiceRole((tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`delete from ${rel(table)} where id = ${row!.id as string}`),
        ),
      );
      expect(del.code).toBe("BL002");
    },
  );

  it.each(APPEND_ONLY)(
    "%s: även databasägaren stoppas (update, delete, truncate)",
    async (table) => {
      const row = await sampleRow(table, F.orgId);
      const column = table === "audit_log" ? sql`occurred_at` : sql`created_at`;
      const outcomes = await asPostgres(async (tx) => [
        await attempt(tx, (sp) =>
          sp.execute(
            sql`update ${rel(table)} set ${column} = now() where id = ${row!.id as string}`,
          ),
        ),
        await attempt(tx, (sp) =>
          sp.execute(sql`delete from ${rel(table)} where id = ${row!.id as string}`),
        ),
        await attempt(tx, (sp) => sp.execute(sql`truncate ${rel(table)} cascade`)),
      ]);
      expect(outcomes.map((o) => o.code)).toEqual(["BL002", "BL002", "BL002"]);
    },
  );

  it("gallringsjobbet (systemroll + binderlab.allow_purge) kan radera import_rows", async () => {
    const row = await sampleRow("import_rows", F.orgId);
    const deleted = await rollback(async (tx) => {
      await tx.execute(sql`select set_config('binderlab.allow_purge', 'on', true)`);
      return affected(tx, sql`delete from public.import_rows where id = ${row!.id as string}`);
    });
    expect(deleted).toBe(1);
    // Flaggan hjälper inte en inloggad användare.
    const asOwner = await asUser(F.owner, (tx) =>
      attempt(tx, async (sp) => {
        await sp.execute(sql`select set_config('binderlab.allow_purge', 'on', true)`);
        await sp.execute(sql`delete from public.stores where organization_id = ${F.orgId}`);
      }),
    );
    expect(asOwner.code).toBe("42501");
  });
});

describe("ekonomiska data raderas inte", () => {
  it.each(["orders", "purchase_prices", "store_agreements", "machines", "titles", "stores"])(
    "%s: delete nekas även för service_role",
    async (table) => {
      const row = await sampleRow(table, F.orgId);
      const outcome = await asServiceRole((tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`delete from ${rel(table)} where id = ${row!.id as string}`),
        ),
      );
      expect(outcome.ok).toBe(false);
      expect(["BL003", "23503"]).toContain(outcome.code);
    },
  );
});

describe("en raderad användare (GDPR)", () => {
  it("nollas i aktörskolumner och profilen anonymiseras, men händelserna finns kvar", async () => {
    const refiller = await createMember(F.orgId, "refiller");
    const [event] = await asUser(refiller, (tx) =>
      tx
        .insert(s.stockEvents)
        .values({
          organizationId: F.orgId,
          locationId: F.machineLocationId,
          titleId: F.titleId,
          kind: "refill",
          quantity: 4,
          performedBy: refiller.id,
        })
        .returning({ id: s.stockEvents.id }),
    );
    await db().execute(sql`delete from auth.users where id = ${refiller.id}`);

    const after = await one<{ performed_by: string | null; created_by: string | null }>(
      db(),
      sql`select performed_by, created_by from public.stock_events where id = ${event!.id}`,
    );
    expect(after).toEqual({ performed_by: null, created_by: null });
    const audit = await one<{ actor_id: string | null }>(
      db(),
      sql`select actor_id from public.audit_log where table_name = 'stock_events' and row_id = ${event!.id}`,
    );
    expect(audit.actor_id).toBeNull();
    const profile = await one<{
      display_name: string;
      anonymized_at: Date | null;
      user_id: string | null;
    }>(
      db(),
      sql`select display_name, anonymized_at, user_id from public.profiles
          where organization_id = ${F.orgId} and anonymized_at is not null`,
    );
    expect(profile.display_name).toBe("Borttagen användare");
    expect(profile.user_id).toBeNull();
    const membership = await rows(
      db(),
      sql`select 1 from public.memberships where organization_id = ${F.orgId} and user_id = ${refiller.id}`,
    );
    expect(membership).toHaveLength(0);
  });
});
