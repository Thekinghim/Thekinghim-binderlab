/**
 * Demoorganisationen blandas aldrig med den riktiga: båda seedas i samma
 * databas, och demoanvändarna (alla tre roller) ser bara demon medan den
 * riktiga organisationens användare bara ser sin egen. Återställningen
 * raderar bara demon och vägrar för allt annat, även en kundorganisation som
 * fått demons slug ur sitt namn.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { LocalFileStore } from "../../src/import/file-store";
import { DEMO_USERS } from "../../src/seed/demo/catalog";
import { resetDemo, runDemoSeed, type RunDemoSeedResult } from "../../src/seed/demo/run-demo-seed";
import { runSeed, type RunSeedResult } from "../../src/seed/run-seed";
import { slugFromName } from "../../src/server/onboarding/create-organization";
import { asUser, createUser, db, one, orgScopedTables, rows, type TestUser } from "./helpers";

const PASSWORD = "binderlab-dev-test";
const scoped = await orgScopedTables();

let real: RunSeedResult;
let demo: RunDemoSeedResult;
let realCounts: Record<string, number>;

async function countsFor(orgId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of scoped) {
    const r = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from ${sql.identifier("public")}.${sql.identifier(t)}
          where organization_id = ${orgId}::uuid`,
    );
    out[t] = r.n;
  }
  return out;
}

/** Organisationerna vars rader användaren ser i tabellen (med RLS). */
async function visibleOrgs(user: TestUser, table: string): Promise<string[]> {
  const r = await asUser(user, (tx) =>
    rows<{ org: string }>(
      tx,
      sql`select distinct organization_id::text as org
          from ${sql.identifier("public")}.${sql.identifier(table)}`,
    ),
  );
  return r.map((x) => x.org).sort();
}

const DATA_TABLES = [
  "orders",
  "stores",
  "machines",
  "titles",
  "stock_events",
  "store_agreements",
  "purchase_prices",
  "imports",
  "payouts",
  "incidents",
  "alerts",
  "goals",
];

beforeAll(async () => {
  const fileStore = new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-demo-iso-")));
  real = await runSeed(db(), { password: PASSWORD, manageUsers: true, fileStore });
  realCounts = await countsFor(real.organizationId);
  demo = await runDemoSeed(db(), { password: PASSWORD, manageUsers: true, fileStore });
}, 300_000);

describe("demo: isolering mot den riktiga organisationen", () => {
  it("den riktiga organisationen är orörd av demon", async () => {
    expect(await countsFor(real.organizationId)).toEqual(realCounts);
    const r = await one<{ n: number; total: string }>(
      db(),
      sql`select count(*)::int as n, sum(amount_ore)::text as total
          from public.orders where organization_id = ${real.organizationId}::uuid`,
    );
    expect(r).toEqual({ n: 460, total: "7998700" });
  });

  it("demoanvändarna är bara medlemmar i demon, de riktiga aldrig i demon", async () => {
    const r = await rows<{ email: string; org: string }>(
      db(),
      sql`select u.email::text as email, m.organization_id::text as org
          from public.memberships m join auth.users u on u.id = m.user_id
          where m.organization_id in (${real.organizationId}::uuid, ${demo.organizationId}::uuid)
          order by 1`,
    );
    for (const m of r) {
      const isDemoUser = m.email.startsWith("demo");
      expect(m.org, m.email).toBe(isDemoUser ? demo.organizationId : real.organizationId);
    }
    expect(r.filter((m) => m.org === demo.organizationId)).toHaveLength(3);
  });

  it.each(Object.entries(DEMO_USERS))("demons %s ser bara demon", async (_key, u) => {
    const id = (
      await one<{ id: string }>(db(), sql`select id from auth.users where email = ${u.email}`)
    ).id;
    const user = { id, email: u.email };
    for (const table of DATA_TABLES) {
      const orgs = await visibleOrgs(user, table);
      expect(
        orgs.every((o) => o === demo.organizationId),
        `${u.email} ${table}`,
      ).toBe(true);
    }
    const orgs = await asUser(user, (tx) =>
      rows<{ id: string }>(tx, sql`select id::text as id from public.organizations`),
    );
    expect(orgs.map((o) => o.id)).toEqual([demo.organizationId]);
  });

  it("den riktiga ägaren och delägaren ser ingenting av demon", async () => {
    for (const userId of [real.users.owner, real.users.partner]) {
      const email = (
        await one<{ email: string }>(
          db(),
          sql`select email::text as email from auth.users where id = ${userId}::uuid`,
        )
      ).email;
      for (const table of DATA_TABLES) {
        const orgs = await visibleOrgs({ id: userId, email }, table);
        expect(orgs.includes(demo.organizationId), `${email} ${table}`).toBe(false);
      }
    }
  });

  it("demons order kommer bara från demons datakälla och automater", async () => {
    const r = await one<{ foreign: number }>(
      db(),
      sql`select count(*)::int as foreign from public.orders o
          where o.organization_id = ${demo.organizationId}::uuid
            and (o.data_source_id <> ${demo.dataSourceId}::uuid
                 or o.machine_id not in (select id from public.machines where organization_id = ${demo.organizationId}::uuid))`,
    );
    expect(r.foreign).toBe(0);
  });
});

describe("demo: återställning", () => {
  it("vägrar för allt som inte är demon", async () => {
    await expect(resetDemo(db(), "binderlab")).rejects.toThrow(/inte en demoorganisation/);
  });

  it("vägrar en kundorganisation som fått demons slug ur sitt namn", async () => {
    // Samma väg som onboardingen: slug ur namnet, skapad av en vanlig användare.
    const name = "Nordljus (demo) stor";
    const slug = slugFromName(name);
    expect(slug).toBe("nordljus-demo-stor");
    const customer = await createUser();
    const created = await asUser(customer, (tx) =>
      one<{ id: string }>(tx, sql`select public.create_organization(${name}, ${slug}) as id`),
    );
    await asUser(customer, (tx) =>
      tx.execute(
        sql`insert into public.stores (organization_id, name) values (${created.id}::uuid, 'Kundens butik')`,
      ),
    );
    const before = await countsFor(created.id);

    await expect(resetDemo(db(), slug)).rejects.toThrow(/inte av demons ägare/);
    // Seeden (--stor) skriver inte heller i den.
    await expect(
      runDemoSeed(db(), { password: PASSWORD, manageUsers: true, large: true }),
    ).rejects.toThrow(/inte av demons ägare/);

    const left = await rows(
      db(),
      sql`select 1 from public.organizations where id = ${created.id}::uuid`,
    );
    expect(left).toHaveLength(1);
    expect(await countsFor(created.id)).toEqual(before);
  }, 120_000);

  it("vägrar radera demon när någon utanför demon är medlem", async () => {
    const colleague = await createUser();
    await db().execute(
      sql`insert into public.memberships (organization_id, user_id, role)
          values (${demo.organizationId}::uuid, ${colleague.id}::uuid, 'viewer')`,
    );
    try {
      await expect(resetDemo(db(), "nordljus-demo")).rejects.toThrow(colleague.email);
      const left = await rows(
        db(),
        sql`select 1 from public.orders where organization_id = ${demo.organizationId}::uuid limit 1`,
      );
      expect(left).toHaveLength(1);
    } finally {
      await db().execute(
        sql`delete from public.memberships
            where organization_id = ${demo.organizationId}::uuid and user_id = ${colleague.id}::uuid`,
      );
    }
  });

  it("raderar demon helt och lämnar den riktiga organisationen orörd", async () => {
    const removed = await resetDemo(db(), "nordljus-demo");
    expect(removed?.organizationId).toBe(demo.organizationId);
    expect(removed?.deleted.orders).toBe(demo.totals.orders);
    expect(await countsFor(demo.organizationId)).toEqual(
      Object.fromEntries(scoped.map((t) => [t, 0])),
    );
    const org = await rows(
      db(),
      sql`select 1 from public.organizations where id = ${demo.organizationId}::uuid`,
    );
    expect(org).toHaveLength(0);
    expect(await countsFor(real.organizationId)).toEqual(realCounts);
    expect(await resetDemo(db(), "nordljus-demo")).toBeNull();
  });
});
