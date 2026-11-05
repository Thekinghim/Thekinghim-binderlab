/**
 * Demo för kunder (src/server/demo/customer-demos.ts): ägaren i en riktig organisation
 * skapar en demo åt en kund, kunden går med som ägare och klickar runt.
 *
 * Det viktiga: kunden ser ALDRIG något från den riktiga organisationen (ingen rad i någon
 * tabell, vy eller RPC; inte organisationen i växlaren, inbjudningar eller medlemslistan),
 * aldrig en hemlighet (Vault, nycklar), och inget går ut från demon (inbjudningar och
 * Awish nekas). Inga riktiga användare är med i demon.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql, type SQL } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { LocalFileStore } from "../../src/import/file-store";
import { runSeed, type RunSeedResult } from "../../src/seed/run-seed";
import { isDemoBlocked } from "../../src/server/assistant/advisor/service";
import {
  continueCustomerDemoFor,
  createCustomerDemoFor,
  CUSTOMER_DEMO_MESSAGES,
  deleteCustomerDemoFor,
  listCustomerDemosFor,
  resendCustomerDemoInviteFor,
  resetCustomerDemoFor,
  stockholmClock,
  type CustomerDemoDeps,
} from "../../src/server/demo/customer-demos";
import {
  asUser,
  attempt,
  createUser,
  db,
  one,
  pgError,
  publicTables,
  publicViews,
  rel,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const PASSWORD = "binderlab-dev-test";
const tables = await publicTables();
const views = await publicViews();

let real: RunSeedResult;
let owner: TestUser;
let partner: TestUser;
let customer: TestUser;
let demoId: string;
let demoOrgId: string;
let markers: string[];
const mail: { to: string; url: string }[] = [];
const created: string[] = [];
const deleted: string[] = [];
let createSeconds = 0;

const deps: CustomerDemoDeps = {
  db,
  baseUrl: "http://localhost:3200",
  users: {
    async createSystemUser(email, fullName) {
      const r = await one<{ id: string }>(
        db(),
        sql`insert into auth.users (email, raw_user_meta_data)
            values (${email}, ${JSON.stringify({ full_name: fullName })}::jsonb) returning id`,
      );
      created.push(r.id);
      return r.id;
    },
    async deleteUser(id) {
      deleted.push(id);
      await db().execute(sql`delete from auth.users where id = ${id}::uuid`);
    },
  },
  async sendInvite(to, url) {
    mail.push({ to, url });
  },
  fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-demo-kund-"))),
};

const user = (u: TestUser) => ({ userId: u.id, email: u.email });

async function build(id: string): Promise<{ calls: number }> {
  let calls = 0;
  for (;;) {
    calls++;
    const r = await continueCustomerDemoFor(user(owner), deps, {
      organizationId: real.organizationId,
      demoId: id,
    });
    if (!r.ok) throw new Error(r.error);
    if (r.data?.status === "ready") return { calls };
    if (calls > 50) throw new Error("Demon blev aldrig klar.");
  }
}

async function demoOrgOf(id: string): Promise<string> {
  return (
    await one<{ org: string }>(
      db(),
      sql`select demo_organization_id::text as org from private.customer_demos where id = ${id}::uuid`,
    )
  ).org;
}

/** Som användaren, och allt rullas tillbaka. */
async function peek<T>(
  u: TestUser,
  query: SQL,
): Promise<{ ok: boolean; code?: string; rows: T[] }> {
  const out = await asUser(u, (tx) =>
    attempt(tx, async (sp) => Array.from(await sp.execute(query)) as T[]),
  );
  return out.ok ? { ok: true, rows: out.value } : { ok: false, code: out.code, rows: [] };
}

beforeAll(async () => {
  const suffix = uniqueSuffix();
  real = await runSeed(db(), {
    password: PASSWORD,
    manageUsers: true,
    fileStore: deps.fileStore,
    organization: { name: `Riktig ${suffix}`, slug: `riktig-${suffix}` },
    users: {
      owner: {
        email: `agare-${suffix}@test.binderlab.se`,
        fullName: "Riktig Ägare",
        role: "owner",
      },
      partner: {
        email: `delagare-${suffix}@test.binderlab.se`,
        fullName: "Riktig Delägare",
        role: "viewer",
      },
    },
  });
  owner = { id: real.users.owner, email: `agare-${suffix}@test.binderlab.se` };
  partner = { id: real.users.partner, email: `delagare-${suffix}@test.binderlab.se` };

  const t0 = Date.now();
  const r = await createCustomerDemoFor(user(owner), deps, {
    organizationId: real.organizationId,
    email: `Kund-${suffix}@Kund.example`,
  });
  if (!r.ok || !r.data) throw new Error(r.ok ? "inget id" : r.error);
  demoId = r.data.id;
  await build(demoId);
  createSeconds = (Date.now() - t0) / 1000;
  demoOrgId = await demoOrgOf(demoId);

  // Kunden är ett helt nytt konto som accepterar inbjudan från mejlet.
  customer = await createUser(`kund-${suffix}@kund.example`);
  const token = mail.at(-1)?.url.split("/inbjudan/")[1] ?? "";
  await asUser(customer, (tx) => tx.execute(sql`select public.accept_invitation(${token})`));

  // Allt som pekar ut den riktiga organisationen: id:n, namn, e-post och butikernas namn.
  const stores = await rows<{ name: string }>(
    db(),
    sql`select name from public.stores where organization_id = ${real.organizationId}::uuid`,
  );
  const machines = await rows<{ id: string }>(
    db(),
    sql`select id::text as id from public.machines where organization_id = ${real.organizationId}::uuid`,
  );
  markers = [
    real.organizationId,
    `Riktig ${suffix}`,
    `riktig-${suffix}`,
    owner.id,
    owner.email,
    partner.id,
    partner.email,
    "Riktig Ägare",
    ...stores.map((s) => s.name),
    ...machines.map((m) => m.id),
  ];
}, 600_000);

describe("demo för kunder: skapa", () => {
  it("skapas inom Vercels gräns och mejlar en inbjudan som ägare", async () => {
    console.info(`[demo-kunder] demon skapades på ${createSeconds.toFixed(1)} s`);
    expect(createSeconds).toBeLessThan(280);
    expect(mail.at(-1)?.to).toBe(customer.email);
    const inv = await one<{ role: string; email: string }>(
      db(),
      sql`select role::text as role, email::text as email from public.invitations
          where organization_id = ${demoOrgId}::uuid and email = ${customer.email}`,
    );
    expect(inv.role).toBe("owner");
  });

  it("demon är en egen demoorganisation med data som slutar nu", async () => {
    const org = await one<{ is_demo: boolean; name: string; created_by: string }>(
      db(),
      sql`select is_demo, name, created_by::text as created_by from public.organizations where id = ${demoOrgId}::uuid`,
    );
    expect(org.is_demo).toBe(true);
    expect(org.name).toBe("Nordljus Automater AB (demo)");
    expect(created).toContain(org.created_by);
    const last = await one<{ day: string; n: number }>(
      db(),
      sql`select max(business_date)::text as day, count(*)::int as n
          from public.orders where organization_id = ${demoOrgId}::uuid`,
    );
    expect(last.day).toBe(stockholmClock(new Date()).date);
    expect(last.n).toBeGreaterThan(12_000);
    const real0 = await one<{ is_demo: boolean }>(
      db(),
      sql`select is_demo from public.organizations where id = ${real.organizationId}::uuid`,
    );
    expect(real0.is_demo).toBe(false);
  });

  it("kunden kan prova assistenten (demon spärras inte som den lokala demon)", async () => {
    const org = await one<{ slug: string }>(
      db(),
      sql`select slug from public.organizations where id = ${demoOrgId}::uuid`,
    );
    expect(org.slug).toMatch(/^kunddemo-[0-9a-f]{10}$/);
    expect(isDemoBlocked(org.slug, { NODE_ENV: "production" })).toBe(false);
  });

  it("ingen riktig användare är medlem i demon: bara platshållarna och kunden", async () => {
    const members = await rows<{ email: string; role: string }>(
      db(),
      sql`select u.email::text as email, m.role::text as role
          from public.memberships m join auth.users u on u.id = m.user_id
          where m.organization_id = ${demoOrgId}::uuid order by 1`,
    );
    expect(members).toHaveLength(4);
    for (const m of members) {
      if (m.email === customer.email) expect(m.role).toBe("owner");
      else expect(m.email).toMatch(/^[a-z]+\.[a-z]+\.[0-9a-f]{8}@nordljus\.invalid$/);
    }
    const passwords = await rows<{ p: string | null }>(
      db(),
      sql`select encrypted_password as p from auth.users where email::text like '%@nordljus.invalid'
          and id = any(${`{${created.join(",")}}`}::uuid[])`,
    );
    expect(passwords.every((p) => p.p === null || !p.p.includes(PASSWORD))).toBe(true);
  });

  it("nekar en adress som redan används i en riktig organisation, och dubbletter", async () => {
    for (const email of [owner.email, partner.email.toUpperCase()]) {
      const r = await createCustomerDemoFor(user(owner), deps, {
        organizationId: real.organizationId,
        email,
      });
      expect(r).toEqual({ ok: false, error: CUSTOMER_DEMO_MESSAGES.realUser });
    }
    const dup = await createCustomerDemoFor(user(owner), deps, {
      organizationId: real.organizationId,
      email: customer.email,
    });
    expect(dup).toEqual({ ok: false, error: CUSTOMER_DEMO_MESSAGES.duplicate });
  });

  it("bara ägaren i en riktig organisation: delägaren, kunden och demon nekas", async () => {
    const args = { organizationId: real.organizationId, email: "x@kund.example" };
    expect((await createCustomerDemoFor(user(partner), deps, args)).ok).toBe(false);
    expect((await createCustomerDemoFor(user(customer), deps, args)).ok).toBe(false);
    const inDemo = await createCustomerDemoFor(user(customer), deps, {
      organizationId: demoOrgId,
      email: "y@kund.example",
    });
    expect(inDemo).toEqual({ ok: false, error: CUSTOMER_DEMO_MESSAGES.insideDemo });
    for (const flow of [continueCustomerDemoFor, resetCustomerDemoFor, deleteCustomerDemoFor]) {
      for (const who of [partner, customer]) {
        const r = await flow(user(who), deps, { organizationId: real.organizationId, demoId });
        expect(r.ok, `${flow.name} ${who.email}`).toBe(false);
      }
      const viaDemo = await flow(user(customer), deps, { organizationId: demoOrgId, demoId });
      expect(viaDemo.ok).toBe(false);
    }
    expect((await listCustomerDemosFor(user(partner), real.organizationId)).ok).toBe(false);
    expect((await listCustomerDemosFor(user(customer), demoOrgId)).ok).toBe(false);
  });

  it("ägarens lista visar kunden som accepterad", async () => {
    const r = await listCustomerDemosFor(user(owner), real.organizationId);
    expect(r.ok).toBe(true);
    const item = r.data?.find((d) => d.id === demoId);
    expect(item).toMatchObject({ customerEmail: customer.email, status: "ready", accepted: true });
    // Listan lämnar aldrig ut demons id eller platshållarna.
    expect(JSON.stringify(r.data)).not.toContain(demoOrgId);
  });
});

describe("demo för kunder: kunden ser aldrig den riktiga organisationen", () => {
  it("bara demon i organisationsväxlaren", async () => {
    const r = await peek<{ id: string }>(
      customer,
      sql`select id::text as id from public.organizations`,
    );
    expect(r.rows.map((x) => x.id)).toEqual([demoOrgId]);
  });

  it("kontroll: samma sökning hittar den riktiga organisationen för dess ägare", async () => {
    const pattern = markers.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const r = await peek<{ n: number }>(
      owner,
      sql`select count(*)::int as n from public.stores t where to_jsonb(t)::text ~* ${pattern}`,
    );
    expect(r.rows[0]?.n ?? 0).toBeGreaterThan(0);
  });

  it.each([...tables, ...views])(
    "%s: ingen rad pekar ut den riktiga organisationen",
    async (relation) => {
      const pattern = markers.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const r = await peek<{ n: number }>(
        customer,
        sql`select count(*)::int as n from ${rel(relation)} t where to_jsonb(t)::text ~* ${pattern}`,
      );
      // Tabeller som kunden inte får läsa alls ger behörighetsfel, vilket också är rätt.
      expect(r.ok ? r.rows[0]?.n : 0, relation).toBe(0);
      const cols = await rows<{ c: string }>(
        db(),
        sql`select column_name as c from information_schema.columns
          where table_schema = 'public' and table_name = ${relation} and column_name = 'organization_id'`,
      );
      if (cols.length > 0 && r.ok) {
        const foreign = await peek<{ n: number }>(
          customer,
          sql`select count(*)::int as n from ${rel(relation)} where organization_id <> ${demoOrgId}::uuid`,
        );
        expect(foreign.rows[0]?.n ?? 0, relation).toBe(0);
      }
    },
  );

  it("RPC:erna med den riktiga organisationens id ger fel eller ingenting", async () => {
    const R = sql`${real.organizationId}::uuid`;
    const calls: Record<string, SQL> = {
      list_members: sql`select * from public.list_members(${R})`,
      my_invitations: sql`select * from public.my_invitations()`,
      lager_performers: sql`select * from public.lager_performers(${R})`,
      lager_slot_periods: sql`select * from public.lager_slot_periods(${R})`,
      sales_data_until: sql`select public.sales_data_until(${R})`,
      list_customer_demos: sql`select * from public.list_customer_demos(${R})`,
      list_customer_demos_demo: sql`select * from public.list_customer_demos(${demoOrgId}::uuid)`,
      portal_stores: sql`select * from public.portal_stores()`,
      create_invitation: sql`select public.create_invitation(${R}, 'x@kund.example', 'owner')`,
    };
    const pattern = new RegExp(
      markers.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "i",
    );
    for (const [name, q] of Object.entries(calls)) {
      const r = await peek<Record<string, unknown>>(customer, q);
      const text = JSON.stringify(r.rows);
      expect(pattern.test(text), `${name}: ${text.slice(0, 200)}`).toBe(false);
      if (name.startsWith("list_customer_demos") || name === "create_invitation") {
        expect(r.ok, name).toBe(false);
      }
    }
  });

  it("ALLA RPC:er med den riktiga organisationens id:n: fel eller tomt, aldrig något därifrån", async () => {
    // Varje funktion i public som kunden får köra, med den riktiga organisationens,
    // butikens och automatens id:n. Allt körs i en transaktion som rullas tillbaka.
    const fns = await rows<{ name: string; args: string[] | null; types: string[] }>(
      db(),
      sql`select p.proname as name, p.proargnames::text[] as args,
                 array(select format_type(t, null) from unnest(p.proargtypes) t)::text[] as types
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype
            and has_function_privilege('authenticated', p.oid, 'execute')
          order by 1`,
    );
    expect(fns.length).toBeGreaterThan(30);
    const store = await one<{ id: string }>(
      db(),
      sql`select id::text as id from public.stores where organization_id = ${real.organizationId}::uuid limit 1`,
    );
    const machine = await one<{ id: string }>(
      db(),
      sql`select id::text as id from public.machines where organization_id = ${real.organizationId}::uuid limit 1`,
    );
    const pattern = new RegExp(
      markers.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "i",
    );
    const empty = (v: unknown): boolean =>
      v === null || v === false || v === "" || (Array.isArray(v) && v.length === 0);
    const ROLLBACK = new Error("rollback");
    for (const fn of fns) {
      const targetsReal = fn.types.some(
        (t, i) => t === "uuid" && /organization|store/.test(fn.args?.[i] ?? ""),
      );
      const args = fn.types.map((type, i) => {
        const name = fn.args?.[i] ?? "";
        if (type === "uuid") {
          if (name.includes("organization")) return sql`${real.organizationId}::uuid`;
          if (name.includes("store")) return sql`${store.id}::uuid`;
          return sql`${machine.id}::uuid`;
        }
        if (type === "text") return sql`'x'`;
        return sql`${sql.raw(`null::${type}`)}`;
      });
      const call = sql`select * from ${sql.raw(`public.${fn.name}`)}(${sql.join(args, sql`, `)}) r`;
      let out: { ok: boolean; rows: Record<string, unknown>[] } = { ok: false, rows: [] };
      try {
        await asUser(customer, async (tx) => {
          const r = await attempt(
            tx,
            async (sp) => Array.from(await sp.execute(call)) as Record<string, unknown>[],
          );
          out = { ok: r.ok, rows: r.ok ? r.value : [] };
          throw ROLLBACK;
        });
      } catch (error) {
        if (error !== ROLLBACK) throw error;
      }
      const text = JSON.stringify(out.rows);
      expect(pattern.test(text), `${fn.name}: ${text.slice(0, 200)}`).toBe(false);
      if (targetsReal && out.ok) {
        // Lyckades anropet mot den riktiga organisationen får det inte ha gett något.
        expect(
          out.rows.every((row) => Object.values(row).every(empty)),
          `${fn.name}: ${text.slice(0, 200)}`,
        ).toBe(true);
      }
    }
  });

  it("Vault, auth.users och kopplingen till den riktiga organisationen går inte att läsa", async () => {
    for (const q of [
      sql`select count(*) from vault.decrypted_secrets`,
      sql`select count(*) from vault.secrets`,
      sql`select count(*) from auth.users`,
      sql`select count(*) from private.customer_demos`,
    ]) {
      const r = await peek(customer, q);
      expect(r.ok).toBe(false);
      expect(r.code).toBe("42501");
    }
  });

  it("demons organisationsrad säger inte vem som skapade den", async () => {
    const r = await peek<{ row: Record<string, unknown> }>(
      customer,
      sql`select to_jsonb(o) as row from public.organizations o`,
    );
    const text = JSON.stringify(r.rows);
    expect(text).not.toContain(real.organizationId);
    expect(text).not.toContain(owner.id);
  });

  it("den riktiga ägaren och delägaren ser inte demon", async () => {
    for (const u of [owner, partner]) {
      const r = await peek<{ id: string }>(u, sql`select id::text as id from public.organizations`);
      expect(r.rows.map((x) => x.id)).not.toContain(demoOrgId);
      const orders = await peek<{ n: number }>(
        u,
        sql`select count(*)::int as n from public.orders where organization_id = ${demoOrgId}::uuid`,
      );
      expect(orders.rows[0]?.n ?? 0).toBe(0);
    }
  });
});

describe("demo för kunder: inget går ut från demon", () => {
  it("kunden kan inte bjuda in någon (inte heller till butiksportalen)", async () => {
    const r = await peek(
      customer,
      sql`select public.create_invitation(${demoOrgId}::uuid, 'kollega@kund.example', 'viewer')`,
    );
    expect(r.code).toBe("BL090");
    const store = await one<{ id: string }>(
      db(),
      sql`select id::text as id from public.stores where organization_id = ${demoOrgId}::uuid limit 1`,
    );
    const portal = await peek(
      customer,
      sql`select public.create_store_invitation(${demoOrgId}::uuid, ${store.id}::uuid, 'butik@kund.example')`,
    );
    expect(portal.code).toBe("BL090");
  });

  it("kunden kan inte koppla Awish (gRPC, webb eller tillägget)", async () => {
    for (const provider of ["awish_grpc", "awish_web", "awish_extension"]) {
      const r = await peek(
        customer,
        sql`insert into public.data_sources (organization_id, provider, name)
            values (${demoOrgId}::uuid, ${provider}::public.data_source_provider, ${`Awish ${provider}`})`,
      );
      expect(r.code, provider).toBe("BL092");
    }
    const csv = await peek(
      customer,
      sql`update public.data_sources set provider = 'awish_grpc' where organization_id = ${demoOrgId}::uuid`,
    );
    expect(csv.code).toBe("BL092");
  });

  it("en medlem i en riktig organisation kan inte gå med i en demo", async () => {
    let code = "";
    try {
      await db().execute(
        sql`insert into public.memberships (organization_id, user_id, role)
            values (${demoOrgId}::uuid, ${partner.id}::uuid, 'viewer')`,
      );
    } catch (error) {
      code = pgError(error)?.code ?? "";
    }
    const r = { code };
    expect(r.code).toBe("BL091");
  });

  it("kunden kan inte skapa en egen riktig organisation (RPC:n direkt, som via PostgREST)", async () => {
    // Annars tar sig kunden ur demon: en riktig organisation där inbjudningar, mejl,
    // Awish och Demo för kunder (nya konton och mejl) fungerar.
    const r = await peek(
      customer,
      sql`select public.create_organization('Kundens eget AB', ${`kundens-eget-${uniqueSuffix()}`})`,
    );
    expect(r.code).toBe("BL093");
    const orgs = await peek<{ id: string }>(
      customer,
      sql`select id::text as id from public.organizations`,
    );
    expect(orgs.rows.map((o) => o.id)).toEqual([demoOrgId]);
  });

  it("is_demo kan inte ändras av kunden", async () => {
    const r = await peek(
      customer,
      sql`update public.organizations set is_demo = false where id = ${demoOrgId}::uuid`,
    );
    expect(r.code).toBe("42501");
  });
});

describe("demo för kunder: bjud in igen, återställ och ta bort", () => {
  it("bjud in igen nekas när kunden redan gått med", async () => {
    const r = await resendCustomerDemoInviteFor(user(owner), deps, {
      organizationId: real.organizationId,
      demoId,
    });
    expect(r).toEqual({ ok: false, error: CUSTOMER_DEMO_MESSAGES.accepted });
  });

  it("återställ ger en ny demo och kunden är kvar som ägare", async () => {
    // Kunden ändrar något i demon.
    await asUser(customer, (tx) =>
      tx.execute(
        sql`update public.stores set name = 'Kundens ändring' where organization_id = ${demoOrgId}::uuid`,
      ),
    );
    const mailsBefore = mail.length;
    const r = await resetCustomerDemoFor(user(owner), deps, {
      organizationId: real.organizationId,
      demoId,
    });
    expect(r.ok).toBe(true);
    await build(demoId);
    const fresh = await demoOrgOf(demoId);
    expect(fresh).not.toBe(demoOrgId);
    const old = await rows(
      db(),
      sql`select 1 from public.organizations where id = ${demoOrgId}::uuid`,
    );
    expect(old).toHaveLength(0);
    const r2 = await peek<{ id: string }>(
      customer,
      sql`select id::text as id from public.organizations`,
    );
    expect(r2.rows.map((x) => x.id)).toEqual([fresh]);
    const role = await peek<{ role: string }>(
      customer,
      sql`select role::text as role from public.memberships where organization_id = ${fresh}::uuid and user_id = ${customer.id}::uuid`,
    );
    expect(role.rows[0]?.role).toBe("owner");
    const changed = await rows(
      db(),
      sql`select 1 from public.stores where organization_id = ${fresh}::uuid and name = 'Kundens ändring'`,
    );
    expect(changed).toHaveLength(0);
    expect(mail.length).toBe(mailsBefore); // inget nytt mejl: kunden var redan med
    demoOrgId = fresh;
  }, 600_000);

  it("ta bort raderar demon, platshållarna och kundens demokonto, men inget annat", async () => {
    const realBefore = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.orders where organization_id = ${real.organizationId}::uuid`,
    );
    const placeholders = await one<{ ids: string[] }>(
      db(),
      sql`select placeholder_user_ids::text[] as ids from private.customer_demos where id = ${demoId}::uuid`,
    );
    const r = await deleteCustomerDemoFor(user(owner), deps, {
      organizationId: real.organizationId,
      demoId,
    });
    expect(r).toEqual({ ok: true });
    expect(
      await rows(db(), sql`select 1 from public.organizations where id = ${demoOrgId}::uuid`),
    ).toHaveLength(0);
    expect(deleted).toEqual(expect.arrayContaining([...placeholders.ids, customer.id]));
    expect(deleted).not.toContain(owner.id);
    expect(deleted).not.toContain(partner.id);
    const realAfter = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.orders where organization_id = ${real.organizationId}::uuid`,
    );
    expect(realAfter.n).toBe(realBefore.n);
    const list = await listCustomerDemosFor(user(owner), real.organizationId);
    expect(list.data?.some((d) => d.id === demoId)).toBe(false);
  }, 120_000);
});
