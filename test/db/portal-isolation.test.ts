/**
 * Butiksportalen: rollen store har INGA rättigheter i appens tabeller, vyer,
 * RPC:er eller filer. Kontrolleras mot katalogen (varje tabell och vy i public),
 * så att en ny tabell eller policy som släpper in rollen får testet att fallera.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  getRoleFor,
  listOrganizationsFor,
  requireRoleFor,
  AuthorizationError,
} from "../../src/server/access";

import {
  asPostgres,
  asUser,
  attempt,
  db,
  one,
  publicTables,
  publicViews,
  rel,
  rows,
} from "./helpers";
import { seedPortalFixture, type PortalFixture } from "./portal-fixture";

let f: PortalFixture;
const tables = await publicTables();
const views = await publicViews();

beforeAll(async () => {
  f = await seedPortalFixture();
});

describe("rollen store och memberships", () => {
  it("inbjudan ger ett medlemskap med rollen store och rätt butik", async () => {
    const m = await one<{ role: string; store_id: string }>(
      db(),
      sql`select role::text as role, store_id from public.memberships
          where user_id = ${f.storeA1.id} and organization_id = ${f.a.orgId}`,
    );
    expect(m).toEqual({ role: "store", store_id: f.a.storeId });
  });

  it("store_id kan bara användas med rollen store, och rollen store kräver store_id", async () => {
    const noStore = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.memberships set store_id = null where user_id = ${f.storeA1.id}`,
        ),
      ),
    );
    expect(noStore.code).toBe("23514");
    const viewerWithStore = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.memberships set store_id = ${f.a.storeId} where user_id = ${f.viewerA.id}`,
        ),
      ),
    );
    expect(viewerWithStore.code).toBe("23514");
  });

  it("butiken måste höra till samma organisation (sammansatt FK)", async () => {
    const outcome = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.memberships set store_id = ${f.b.storeId} where user_id = ${f.storeA1.id}`,
        ),
      ),
    );
    expect(outcome.code).toBe("23503");
  });

  it("en ägare kan inte göra en butiksanvändare till läsare eller admin (rollen kräver ingen butik)", async () => {
    for (const role of ["viewer", "admin", "owner"]) {
      const outcome = await asUser(f.a.owner, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`update public.memberships set role = ${role}::public.member_role
                where user_id = ${f.storeA1.id} and organization_id = ${f.a.orgId}`,
          ),
        ),
      );
      expect(outcome.ok).toBe(false);
    }
  });

  it("ingen klient kan sätta store_id (ingen kolumnrättighet)", async () => {
    const outcome = await asUser(f.a.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.memberships set store_id = ${f.a2.storeId} where user_id = ${f.storeA1.id}`,
        ),
      ),
    );
    expect(outcome.code).toBe("42501");
  });

  it("create_invitation kan inte skapa en butiksinbjudan utan butik", async () => {
    const outcome = await asUser(f.a.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.create_invitation(${f.a.orgId}::uuid, 'x@test.binderlab.se', 'store')`,
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
  });

  it("bara ägare och admin kan bjuda in butiker, och bara till egna butiker", async () => {
    const call = (storeId: string) =>
      sql`select public.create_store_invitation(${f.a.orgId}::uuid, ${storeId}::uuid, ${`n-${Date.now()}@test.binderlab.se`})`;
    for (const user of [f.viewerA, f.refillerA, f.storeA1, f.b.owner]) {
      const outcome = await asUser(user, (tx) =>
        attempt(tx, (sp) => sp.execute(call(f.a.storeId))),
      );
      expect(outcome.code).toBe("42501");
    }
    const admin = await asUser(f.adminA, (tx) =>
      attempt(tx, (sp) => sp.execute(call(f.a.storeId))),
    );
    expect(admin.ok).toBe(true);
    const otherOrgsStore = await asUser(f.a.owner, (tx) =>
      attempt(tx, (sp) => sp.execute(call(f.b.storeId))),
    );
    expect(otherOrgsStore.code).toBe("22023");
  });

  it("butiksanvändaren ser bara sitt eget medlemskap", async () => {
    const own = await asUser(f.storeA1, (tx) =>
      rows<{ user_id: string }>(tx, sql`select user_id from public.memberships`),
    );
    expect(own).toEqual([{ user_id: f.storeA1.id }]);
  });
});

describe("appens tabeller och vyer", () => {
  it.each([...tables, ...views].filter((t) => t !== "memberships"))(
    "%s: butiksanvändaren ser ingenting",
    async (relation) => {
      for (const user of [f.storeA1, f.storeB1]) {
        const outcome = await asUser(user, (tx) =>
          attempt(tx, (sp) =>
            rows<{ n: number }>(sp, sql`select count(*)::int as n from ${rel(relation)}`),
          ),
        );
        // Antingen nekad helt eller 0 rader (RLS).
        if (outcome.ok) expect(outcome.value[0]?.n).toBe(0);
        else expect(outcome.code).toBe("42501");
      }
    },
  );

  it("ingen policy i public nämner rollen store", async () => {
    const policies = await rows<{ name: string }>(
      db(),
      sql`select tablename || '.' || policyname as name from pg_policies
          where schemaname = 'public'
            and (coalesce(qual, '') || coalesce(with_check, '')) ~ '''store''::(public\\.)?member_role'`,
    );
    expect(policies).toEqual([]);
  });

  it("butiksanvändaren kan inte skriva i appens tabeller (ärenden, butiker, order)", async () => {
    const incident = await asUser(f.storeA1, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.incidents (organization_id, machine_id, kind, started_at)
              values (${f.a.orgId}, ${f.a.machineId}, 'store_other', now())`,
        ),
      ),
    );
    expect(incident.code).toBe("42501");
    const updated = await asUser(f.storeA1, (tx) =>
      rows(
        tx,
        sql`update public.stores set name = 'Hackad' where id = ${f.a.storeId} returning id`,
      ),
    );
    expect(updated).toEqual([]);
    const orders = await asUser(f.storeA1, (tx) =>
      rows(
        tx,
        sql`update public.orders set title_id = title_id where organization_id = ${f.a.orgId} returning id`,
      ),
    );
    expect(orders).toEqual([]);
  });
});

describe("appens RPC:er", () => {
  const cases: [string, (orgId: string) => ReturnType<typeof sql>][] = [
    ["list_members", (o) => sql`select * from public.list_members(${o}::uuid)`],
    [
      "create_invitation",
      (o) => sql`select public.create_invitation(${o}::uuid, 'y@test.binderlab.se', 'viewer')`,
    ],
    ["close_period", (o) => sql`select public.close_period(${o}::uuid, '2025-01-01')`],
    ["reopen_period", (o) => sql`select public.reopen_period(${o}::uuid, '2024-12-01')`],
    [
      "merge_titles",
      (o) => sql`select public.merge_titles(${o}::uuid, gen_random_uuid(), gen_random_uuid())`,
    ],
  ];

  it.each(cases)("%s nekas butiksanvändaren", async (_name, call) => {
    const outcome = await asUser(f.storeA1, (tx) =>
      attempt(tx, (sp) => sp.execute(call(f.a.orgId))),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("42501");
  });

  it("varje annan RPC som tar en organisation nekar butiksanvändaren eller lämnar inget", async () => {
    // Alla funktioner i public vars första argument är p_organization_id uuid
    // och som går att anropa med bara det (övriga har standardvärden).
    const fns = await rows<{ name: string }>(
      db(),
      sql`select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prosecdef
            and p.proargnames[1] = 'p_organization_id'
            and p.pronargs - p.pronargdefaults = 1
            and p.proname not in ('create_store_invitation')`,
    );
    for (const { name } of fns) {
      const outcome = await asUser(f.storeA1, (tx) =>
        attempt(tx, (sp) =>
          rows(
            sp,
            sql`select * from ${sql.identifier("public")}.${sql.identifier(name)}(${f.a.orgId}::uuid)`,
          ),
        ),
      );
      if (outcome.ok) expect([name, outcome.value]).toEqual([name, []]);
      else expect([name, outcome.code]).toEqual([name, "42501"]);
    }
  });
});

describe("filer (storage)", () => {
  beforeAll(async () => {
    await asPostgres(async (tx) => {
      const paths = [
        [`${f.a.orgId}/reports/2025-03.pdf`, "reports"],
        [`${f.a.orgId}/reports/a2-2025-03.pdf`, "reports"],
        [`${f.a.orgId}/reports/agare-2025-03.pdf`, "reports"],
        [`${f.a.orgId}/imports/awish.csv`, "imports"],
        [`${f.b.orgId}/reports/2025-03.pdf`, "reports"],
      ];
      for (const [name, bucket] of paths) {
        await tx.execute(
          sql`insert into storage.objects (bucket_id, name) values (${bucket}, ${name})`,
        );
      }
      await tx.execute(
        sql`update public.reports set storage_path = ${`${f.a.orgId}/reports/agare-2025-03.pdf`}
            where id = ${f.ownerReportA}`,
      );
    });
  });

  it("butiksanvändaren ser bara PDF:en till sin egen butiksrapport", async () => {
    const seen = await asUser(f.storeA1, (tx) =>
      rows<{ name: string }>(tx, sql`select name from storage.objects order by name`),
    );
    expect(seen.map((r) => r.name)).toEqual([`${f.a.orgId}/reports/2025-03.pdf`]);
    const seenA2 = await asUser(f.storeA2, (tx) =>
      rows<{ name: string }>(tx, sql`select name from storage.objects order by name`),
    );
    expect(seenA2.map((r) => r.name)).toEqual([`${f.a.orgId}/reports/a2-2025-03.pdf`]);
    const seenB = await asUser(f.storeB1, (tx) =>
      rows<{ name: string }>(tx, sql`select name from storage.objects order by name`),
    );
    expect(seenB.map((r) => r.name)).toEqual([`${f.b.orgId}/reports/2025-03.pdf`]);
  });

  it("butiksanvändaren kan inte ladda upp filer", async () => {
    const outcome = await asUser(f.storeA1, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into storage.objects (bucket_id, name)
              values ('reports', ${`${f.a.orgId}/reports/egen.pdf`})`,
        ),
      ),
    );
    expect(outcome.code).toBe("42501");
  });
});

describe("serverns behörighetskontroll (requireRole, organisationslistan)", () => {
  it("butiksanvändaren har ingen approll: getRoleFor ger null och requireRole nekar", async () => {
    const user = { userId: f.storeA1.id, email: f.storeA1.email };
    expect(await getRoleFor(user, f.a.orgId)).toBeNull();
    await expect(
      requireRoleFor(user, f.a.orgId, ["owner", "admin", "refiller", "viewer"]),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("butiksanvändaren har inga organisationer i appen (skalet släpper inte in den)", async () => {
    const user = { userId: f.storeA1.id, email: f.storeA1.email };
    expect(await listOrganizationsFor(user)).toEqual([]);
  });
});
