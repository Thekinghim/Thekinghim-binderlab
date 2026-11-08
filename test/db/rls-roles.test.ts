/**
 * Roller: påfyllare (tillåtlista), läsare (kan inte skriva), admin (inga
 * ägarbefogenheter), ägare (minst en ägare, ingen rollhöjning).
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "../../src/db/schema";
import {
  affected,
  asPostgres,
  asUser,
  attempt,
  createMember,
  createUser,
  db,
  insertCopySql,
  one,
  publicColumns,
  publicTables,
  publicViews,
  rel,
  rows,
  sampleRow,
  seedTenantFixture,
  type TenantFixture,
  type TestUser,
} from "./helpers";

const tables = await publicTables();
const views = await publicViews();
const relations = [...tables, ...views];
const columns = await publicColumns();

/** Det påfyllaren får läsa (docs/datamodell.md, Roller och åtkomst). */
const REFILLER_ALLOWLIST = [
  "organizations",
  "profiles",
  "memberships",
  "stores",
  "machines",
  "machine_placements",
  "titles",
  "title_aliases",
  "stock_locations",
  "stock_events",
  "stock_levels",
  "warehouse_stock",
  // Fas 3 Att göra: bara avbockningar av lagerpunkter (refill:, stale-machine:).
  "todo_dismissals",
  // Managerpaket: tilldelning av lagerpunkter (20261104170000_managerpaket_ansvar.sql).
  "todo_assignments",
  // Lager: larmgränsen per automat och titel (antal pack, inga belopp).
  "slot_alerts",
  // Fyllnadsgrad: kapacitet och fack från Awish (antal pack, inga belopp).
  "machine_slot_capacity",
  // Mystery packs: innehållet (antal och HIT, inga belopp), påfyllaren packar.
  "mystery_recipes",
  "mystery_recipe_items",
];
/** Påfyllaren ser bara sin egen rad. */
const OWN_ROW_ONLY = ["profiles", "memberships"];
/**
 * Tabeller där läsaren bara ser sina egna rader (fixturens rader är ägarens eller
 * larmjobbets) eller inga alls: larminställningar, push-enheter och utskick per
 * användare (fas 8), egna frågor till assistenten (fas 6b), uppladdningar som bara
 * den som laddade upp ser, och bara som ägare eller admin (Datakällor), och synk-tokens
 * för Chrome-tillägget (bara ägare och admin).
 */
const VIEWER_OWN_ROWS_ONLY = [
  "alert_deliveries",
  "alert_subscriptions",
  // AI-rådgivaren: körningar och förslag syns bara för ägare och admin.
  "ai_runs",
  "ai_suggestions",
  // Morgonbriefen: bara ägare och admin.
  "ai_briefs",
  "assistant_logs",
  // Värde: loggen över automatiskt arbete syns bara för ägare och admin.
  "automation_log",
  // Exportera all data: loggen syns bara för ägaren.
  "data_exports",
  // Gratis-pack: koderna (värda ett pack var) syns bara för ägare och admin.
  "free_pack_codes",
  "import_upload_chunks",
  "import_uploads",
  "push_subscriptions",
  // Daglig kontroll: resultaten syns bara för ägare och admin.
  "self_check_runs",
  // Awish Chrome-tillägget: synk-tokens syns bara för ägare och admin.
  "sync_tokens",
];

let F: TenantFixture;
let refiller: TestUser;
let viewer: TestUser;
let admin: TestUser;

beforeAll(async () => {
  F = await seedTenantFixture();
  refiller = await createMember(F.orgId, "refiller");
  viewer = await createMember(F.orgId, "viewer");
  admin = await createMember(F.orgId, "admin");
});

function orgFilter(relation: string, orgId: string) {
  return relation === "organizations" ? sql`id = ${orgId}` : sql`organization_id = ${orgId}`;
}

async function visibleRows(user: TestUser, relation: string): Promise<number> {
  const { n } = await asUser(user, (tx) =>
    one<{ n: number }>(
      tx,
      sql`select count(*)::int as n from ${rel(relation)} where ${orgFilter(relation, F.orgId)}`,
    ),
  );
  return n;
}

describe("påfyllaren (refiller) ser exakt tillåtlistan", () => {
  it.each(relations)("%s", async (relation) => {
    const n = await visibleRows(refiller, relation);
    if (OWN_ROW_ONLY.includes(relation)) {
      expect(n).toBe(1);
      const { uid } = await asUser(refiller, (tx) =>
        one<{ uid: string }>(
          tx,
          sql`select user_id as uid from ${rel(relation)} where organization_id = ${F.orgId}`,
        ),
      );
      expect(uid).toBe(refiller.id);
    } else if (REFILLER_ALLOWLIST.includes(relation)) {
      expect(n).toBeGreaterThan(0);
    } else {
      expect(n).toBe(0);
    }
  });

  it("ser aldrig belopp: inga *_ore-kolumner i det som är tillåtet", () => {
    const amountColumns = columns.filter(
      (c) =>
        REFILLER_ALLOWLIST.includes(c.table) &&
        /_ore$|amount|cost|price|rent|commission/.test(c.column),
    );
    expect(amountColumns).toEqual([]);
  });

  it("ser bara avbockade lagerpunkter i Att göra, inte prispunkter", async () => {
    const keys = await asUser(refiller, (tx) =>
      rows<{ key: string }>(
        tx,
        sql`select todo_key as key from public.todo_dismissals where organization_id = ${F.orgId}`,
      ),
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => /^(refill|stale-machine):/.test(k.key))).toBe(true);
    const all = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.todo_dismissals where organization_id = ${F.orgId}`,
    );
    expect(all[0]!.n).toBeGreaterThan(keys.length);
  });

  it("ser bara tilldelade lagerpunkter i Att göra, inte prispunkter", async () => {
    const keys = await asUser(refiller, (tx) =>
      rows<{ key: string }>(
        tx,
        sql`select todo_key as key from public.todo_assignments where organization_id = ${F.orgId}`,
      ),
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => /^(refill|stale-machine):/.test(k.key))).toBe(true);
  });

  it("kan inte läsa order, inköpspriser eller ändringsloggen", async () => {
    for (const relation of [
      "orders",
      "purchase_prices",
      "purchase_price_periods",
      "audit_log",
      "store_agreements",
    ]) {
      expect(await visibleRows(refiller, relation)).toBe(0);
    }
  });

  it("kan skapa egna lagerhändelser av typerna påfyllning, inventering, svinn och flytt", async () => {
    const group = randomUUID();
    const created = await asUser(refiller, async (tx) => {
      const base = { organizationId: F.orgId, titleId: F.titleId, performedBy: refiller.id };
      return tx
        .insert(s.stockEvents)
        .values([
          { ...base, locationId: F.machineLocationId, kind: "refill", quantity: 6 },
          { ...base, locationId: F.machineLocationId, kind: "count", quantity: 14 },
          { ...base, locationId: F.machineLocationId, kind: "waste", quantity: -1 },
          {
            ...base,
            locationId: F.centralLocationId,
            kind: "transfer_out",
            quantity: -2,
            transferGroupId: group,
          },
          {
            ...base,
            locationId: F.machineLocationId,
            kind: "transfer_in",
            quantity: 2,
            transferGroupId: group,
          },
        ])
        .returning({ id: s.stockEvents.id, performedBy: s.stockEvents.performedBy });
    });
    expect(created).toHaveLength(5);
    expect(created.every((e) => e.performedBy === refiller.id)).toBe(true);
  });

  it.each(["adjustment", "receipt", "sale"] as const)(
    "kan inte skapa händelser av typen %s",
    async (kind) => {
      const outcome = await asUser(refiller, (tx) =>
        attempt(tx, (sp) =>
          sp.insert(s.stockEvents).values({
            organizationId: F.orgId,
            locationId: F.machineLocationId,
            titleId: F.titleId,
            kind,
            quantity: kind === "sale" ? -1 : 3,
            orderId: kind === "sale" ? F.orderIds[0] : null,
            performedBy: refiller.id,
          }),
        ),
      );
      expect(outcome.code).toBe("42501");
    },
  );

  it("kan inte skapa händelser i någon annans namn", async () => {
    const outcome = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.stockEvents).values({
          organizationId: F.orgId,
          locationId: F.machineLocationId,
          titleId: F.titleId,
          kind: "refill",
          quantity: 3,
          performedBy: F.owner.id,
        }),
      ),
    );
    expect(outcome.code).toBe("42501");
  });

  it("kan inte ändra eller radera lagerhändelser", async () => {
    const update = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.stock_events set quantity = 99 where organization_id = ${F.orgId}`,
        ),
      ),
    );
    expect(update.code).toBe("42501");
    const del = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`delete from public.stock_events where organization_id = ${F.orgId}`),
      ),
    );
    expect(del.code).toBe("42501");
  });

  it("kan inte se andra organisationers lager", async () => {
    const other = await seedTenantFixture();
    const outcome = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.stockEvents).values({
          organizationId: other.orgId,
          locationId: other.machineLocationId,
          titleId: other.titleId,
          kind: "refill",
          quantity: 1,
          performedBy: refiller.id,
        }),
      ),
    );
    expect(outcome.code).toBe("42501");
  });
});

describe("läsaren (viewer)", () => {
  it.each(relations)("ser %s (utom inbjudningar och andras medlemskap)", async (relation) => {
    const n = await visibleRows(viewer, relation);
    if (relation === "invitations") {
      expect(n).toBe(0);
    } else if (relation === "memberships") {
      expect(n).toBe(1);
    } else if (VIEWER_OWN_ROWS_ONLY.includes(relation)) {
      expect(n).toBe(0);
    } else if (tables.includes(relation)) {
      expect(n).toBeGreaterThan(0);
    }
  });

  it.each(tables)("kan inte skriva i %s", async (table) => {
    // En profil får läsaren lägga in åt sig själv (profiles_insert); en kopia av läsarens egen
    // rad krockar då med unikheten (23505) i stället för att nekas. Välj någon annans rad.
    const row = await sampleRow(
      table,
      F.orgId,
      table === "profiles" ? sql`t.user_id is distinct from ${viewer.id}::uuid` : undefined,
    );
    const insert = await asUser(viewer, async (tx) =>
      attempt(tx, async (sp) =>
        sp.execute(
          await insertCopySql(
            table,
            row!,
            table === "organizations"
              ? { id: randomUUID(), slug: `v-${randomUUID().slice(0, 8)}` }
              : { id: randomUUID() },
          ),
        ),
      ),
    );
    expect(insert.code, `insert i ${table}`).toBe("42501");

    const update = await asUser(viewer, (tx) =>
      attempt(tx, (sp) =>
        affected(sp, sql`update ${rel(table)} set id = id where ${orgFilter(table, F.orgId)}`),
      ),
    );
    expect(update.ok ? update.value : update.code, `update i ${table}`).toSatisfy(
      (v: unknown) => v === 0 || v === "42501",
    );

    const del = await asUser(viewer, (tx) =>
      attempt(tx, (sp) =>
        affected(sp, sql`delete from ${rel(table)} where ${orgFilter(table, F.orgId)}`),
      ),
    );
    expect(del.ok ? del.value : del.code, `delete i ${table}`).toSatisfy(
      (v: unknown) => v === 0 || v === "42501",
    );
  });

  it.each(["create_invitation", "close_period", "reopen_period", "merge_titles"])(
    "kan inte köra %s",
    async (fn) => {
      const call = {
        create_invitation: sql`select public.create_invitation(${F.orgId}, 'x@test.binderlab.se', 'viewer')`,
        close_period: sql`select public.close_period(${F.orgId}, '2025-01-01'::date)`,
        reopen_period: sql`select public.reopen_period(${F.orgId}, '2024-12-01'::date)`,
        merge_titles: sql`select public.merge_titles(${F.orgId}, ${F.secondTitleId}, ${F.titleId})`,
      }[fn]!;
      const outcome = await asUser(viewer, (tx) => attempt(tx, (sp) => sp.execute(call)));
      expect(outcome.code).toBe("42501");
    },
  );
});

describe("admin", () => {
  it("kan bjuda in admin, påfyllare och läsare", async () => {
    await asUser(admin, async (tx) => {
      for (const role of ["admin", "refiller", "viewer"] as const) {
        await tx.execute(
          sql`select public.create_invitation(${F.orgId}, ${`ny-${role}-${randomUUID().slice(0, 8)}@test.binderlab.se`}, ${role}::public.member_role)`,
        );
      }
    });
  });

  // Medlemskap skapas bara via create_organization och accept_invitation
  // (samtycke). Direkt insert nekas för alla klientroller, även ägaren, och
  // svaret är detsamma oavsett om user_id finns (ingen FK-orakel).
  it("kan inte lägga till en medlem direkt (inte heller ägaren)", async () => {
    const user = await createUser();
    for (const by of [admin, F.owner]) {
      for (const userId of [user.id, randomUUID()]) {
        const outcome = await asUser(by, (tx) =>
          attempt(tx, (sp) =>
            sp.insert(s.memberships).values({ organizationId: F.orgId, userId, role: "viewer" }),
          ),
        );
        expect(outcome.code).toBe("42501");
      }
    }
  });

  it("kan inte skapa en ägare", async () => {
    const user = await createUser();
    const outcome = await asUser(admin, (tx) =>
      attempt(tx, (sp) =>
        sp
          .insert(s.memberships)
          .values({ organizationId: F.orgId, userId: user.id, role: "owner" }),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(["BL006", "42501"]).toContain(outcome.code);
  });

  it("kan inte bjuda in en ägare", async () => {
    const outcome = await asUser(admin, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.create_invitation(${F.orgId}, 'agare@test.binderlab.se', 'owner')`,
        ),
      ),
    );
    expect(outcome.code).toBe("42501");
  });

  it("kan inte ändra eller ta bort ägarens medlemskap", async () => {
    const changed = await asUser(admin, (tx) =>
      affected(
        tx,
        sql`update public.memberships set role = 'viewer' where organization_id = ${F.orgId} and user_id = ${F.owner.id}`,
      ),
    );
    expect(changed).toBe(0);
    const removed = await asUser(admin, (tx) =>
      affected(
        tx,
        sql`delete from public.memberships where organization_id = ${F.orgId} and user_id = ${F.owner.id}`,
      ),
    );
    expect(removed).toBe(0);
    const { role } = await one<{ role: string }>(
      db(),
      sql`select role from public.memberships where organization_id = ${F.orgId} and user_id = ${F.owner.id}`,
    );
    expect(role).toBe("owner");
  });

  it("kan inte göra sig själv till ägare (rollhöjning)", async () => {
    const outcome = await asUser(admin, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.memberships set role = 'owner' where organization_id = ${F.orgId} and user_id = ${admin.id}`,
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(["BL006", "42501"]).toContain(outcome.code);
  });

  it("kan inte skapa eller ändra ägarandelar", async () => {
    const insert = await asUser(admin, (tx) =>
      attempt(tx, (sp) =>
        sp.insert(s.ownerShares).values({
          organizationId: F.orgId,
          holderName: "Admin",
          shareBp: 10_000,
          validFrom: "2026-01-01",
        }),
      ),
    );
    expect(insert.code).toBe("42501");
    const update = await asUser(admin, (tx) =>
      affected(
        tx,
        sql`update public.owner_shares set share_bp = share_bp where organization_id = ${F.orgId}`,
      ),
    );
    expect(update).toBe(0);
  });

  it("kan inte öppna en stängd månad", async () => {
    const outcome = await asUser(admin, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select public.reopen_period(${F.orgId}, '2024-12-01'::date)`),
      ),
    );
    expect(outcome.code).toBe("42501");
  });

  it("kan inte arkivera organisationen", async () => {
    const outcome = await asUser(admin, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.organizations set archived_at = now() where id = ${F.orgId}`),
      ),
    );
    expect(outcome.code).toBe("42501");
  });
});

describe("ägare och rollhöjning", () => {
  it("sista ägaren kan inte degraderas eller tas bort", async () => {
    const fx = await seedTenantFixture();
    const demote = await asUser(fx.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.memberships set role = 'admin' where organization_id = ${fx.orgId} and user_id = ${fx.owner.id}`,
        ),
      ),
    );
    expect(demote.code).toBe("BL005");
    const remove = await asUser(fx.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`delete from public.memberships where organization_id = ${fx.orgId} and user_id = ${fx.owner.id}`,
        ),
      ),
    );
    expect(remove.code).toBe("BL005");
    // Inte heller som systemet (databasägaren).
    const system = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`delete from public.memberships where organization_id = ${fx.orgId} and role = 'owner'`,
        ),
      ),
    );
    expect(system.code).toBe("BL005");
  });

  it("med två ägare kan den ena degraderas", async () => {
    const fx = await seedTenantFixture();
    const second = await createMember(fx.orgId, "owner");
    await asUser(second, (tx) =>
      tx.execute(
        sql`update public.memberships set role = 'viewer' where organization_id = ${fx.orgId} and user_id = ${fx.owner.id}`,
      ),
    );
    const owners = await rows(
      db(),
      sql`select 1 from public.memberships where organization_id = ${fx.orgId} and role = 'owner'`,
    );
    expect(owners).toHaveLength(1);
  });

  it("påfyllare och läsare kan inte ändra sin roll", async () => {
    for (const user of [refiller, viewer]) {
      const changed = await asUser(user, (tx) =>
        affected(tx, sql`update public.memberships set role = 'owner' where user_id = ${user.id}`),
      );
      expect(changed).toBe(0);
    }
  });

  it("ingen kan läsa eller ändra medlemskap i en annan organisation", async () => {
    const other = await seedTenantFixture();
    const changed = await asUser(F.owner, (tx) =>
      affected(
        tx,
        sql`update public.memberships set role = 'viewer' where organization_id = ${other.orgId}`,
      ),
    );
    expect(changed).toBe(0);
  });
});
