/**
 * Härdning efter den röda granskningen (redteam-isolering och
 * redteam-beh-righet). Granskarnas tester visar att hålen är stängda; de här
 * testerna låser de nya reglerna och att det vanliga flödet fortfarande
 * fungerar.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "../../src/db/schema";
import {
  asPostgres,
  asServiceRole,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  seedTenantFixture,
  uniqueSuffix,
  type TenantFixture,
  type TestUser,
} from "./helpers";

let F: TenantFixture;
let G: TenantFixture;

beforeAll(async () => {
  F = await seedTenantFixture();
  G = await seedTenantFixture();
});

function refill(org: TenantFixture, by: TestUser = org.owner, performedBy?: string) {
  return asUser(by, (tx) =>
    attempt(tx, (sp) =>
      one<{ seq: string }>(
        sp,
        sql`insert into public.stock_events
              (organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by)
            values (${org.orgId}, ${org.centralLocationId}, ${org.titleId}, 'refill', 1,
                    '2025-05-02T10:00:00Z', ${performedBy ?? by.id})
            returning seq::text as seq`,
      ),
    ),
  );
}

describe("stock_events.seq per organisation", () => {
  it("räknar per organisation, och klienter kan inte ange seq själva", async () => {
    const first = await refill(F);
    for (let i = 0; i < 3; i += 1) {
      expect((await refill(G)).ok).toBe(true);
    }
    const forced = await asUser(F.owner, (tx) =>
      one<{ seq: string }>(
        tx,
        sql`insert into public.stock_events
              (organization_id, location_id, title_id, kind, quantity, occurred_at, seq)
            values (${F.orgId}, ${F.centralLocationId}, ${F.titleId}, 'refill', 1,
                    '2025-05-02T10:00:00Z', 1)
            returning seq::text as seq`,
      ),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(BigInt(forced.seq) - BigInt(first.value.seq)).toBe(1n);
  });

  it("sekvenserna ligger i private, namnen avslöjar inte organisationens id och ingen klientroll har rättigheter", async () => {
    const seqs = await rows<{
      schema: string;
      name: string;
      auth: boolean;
      service: boolean;
      anon: boolean;
    }>(
      db(),
      sql`select n.nspname as schema, c.relname as name,
                 has_sequence_privilege('authenticated', c.oid, 'USAGE,SELECT,UPDATE') as auth,
                 has_sequence_privilege('service_role', c.oid, 'USAGE,SELECT,UPDATE') as service,
                 has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') as anon
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'S' and n.nspname in ('public', 'private')`,
    );
    expect(seqs.filter((q) => q.schema === "public")).toEqual([]);
    expect(seqs.length).toBeGreaterThanOrEqual(2);
    for (const q of seqs) {
      expect(q).toMatchObject({ auth: false, service: false, anon: false });
      expect(q.name).not.toContain(F.orgId.replaceAll("-", ""));
      expect(q.name).not.toContain(F.orgId);
    }
  });

  it("en ny organisation får sin sekvens när den skapas", async () => {
    const owner = await createUser();
    const orgId = await createOrg(owner, "Ny sekvens");
    const { exists } = await one<{ exists: boolean }>(
      db(),
      sql`select to_regclass('private.' || quote_ident(private.stock_seq_name(${orgId}::uuid))) is not null as exists`,
    );
    expect(exists).toBe(true);
  });
});

describe("planerarens statistik", () => {
  it("organization_id har ingen statistik i någon tabell (attstattarget = 0)", async () => {
    const missing = await rows<{ table: string }>(
      db(),
      sql`select c.relname as table
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p')
            and a.attname = 'organization_id' and not a.attisdropped
            and coalesce(a.attstattarget::int, -1) <> 0`,
    );
    expect(missing).toEqual([]);
  });
});

describe("sökvägar till filer", () => {
  it.each([
    ["{org}/reports/2025-03.pdf", true],
    ["{org}/imports/orders_2025-05.csv", true],
    ["{org}/a/b/c-d_e.f.txt", true],
    ["{org}/../{other}/x.pdf", false],
    ["{org}/./x.pdf", false],
    ["{org}//x.pdf", false],
    ["{org}/x/", false],
    ["{org}", false],
    ["{org}/", false],
    ["{org}/.hidden", false],
    ["{org}/a\\..\\x.pdf", false],
    ["{org}/%2e%2e/x.pdf", false],
    ["{org}/rapport mars.pdf", false],
    ["{ORG}/x.pdf", false],
    ["/{org}/x.pdf", false],
  ])("%s → %s", async (template, ok) => {
    const path = template
      .replace("{org}", F.orgId)
      .replace("{ORG}", F.orgId.toUpperCase())
      .replace("{other}", G.orgId);
    const { org } = await one<{ org: string | null }>(
      db(),
      sql`select private.storage_path_org(${path})::text as org`,
    );
    expect(org).toBe(ok ? F.orgId : null);
  });

  it("check-villkoren godtar en säker sökväg i den egna organisationen", async () => {
    const outcome = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.imports set storage_path = ${`${F.orgId}/imports/ny-fil.csv`}
              where id = ${F.importId}`,
        ),
      ),
    );
    expect(outcome.ok).toBe(true);
  });
});

describe("hemlighetsreferenser", () => {
  async function setRef(ref: string | null) {
    return asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.data_sources set secret_ref = ${ref} where id = ${F.dataSourceId}`,
        ),
      ),
    );
  }

  it("godtar namn i den egna namnrymden och null", async () => {
    expect((await setRef(`${F.orgId}/awish_grpc`)).ok).toBe(true);
    expect((await setRef(null)).ok).toBe(true);
  });

  it.each(["awish_grpc", "{org}/../x", "{org}/", "{org}/a/b", "{ORG}/awish"])(
    "nekar %s",
    async (template) => {
      const ref = template.replace("{org}", F.orgId).replace("{ORG}", F.orgId.toUpperCase());
      expect((await setRef(ref)).code).toBe("23514");
    },
  );
});

describe("medlemskap och aktörer", () => {
  it("service_role kan fortfarande lägga in medlemskap (serverjobb)", async () => {
    const user = await createUser();
    const outcome = await asServiceRole((tx) =>
      attempt(tx, (sp) =>
        sp
          .insert(s.memberships)
          .values({ organizationId: F.orgId, userId: user.id, role: "viewer" }),
      ),
    );
    expect(outcome.ok).toBe(true);
  });

  it("profiler: en icke-medlem och ett okänt id ger samma fel (inget FK-orakel)", async () => {
    const outsider = await createUser();
    const codes = await Promise.all(
      [outsider.id, randomUUID()].map((userId) =>
        asUser(F.owner, (tx) =>
          attempt(tx, (sp) =>
            sp
              .insert(s.profiles)
              .values({ organizationId: F.orgId, userId, displayName: "Påhittad" }),
          ),
        ),
      ),
    );
    expect(codes.map((c) => c.code)).toEqual(["BL020", "BL020"]);
  });

  it("lagerhändelser: utföraren måste vara medlem, och ett okänt id ger samma fel", async () => {
    const outsider = await createUser();
    expect((await refill(F, F.owner, outsider.id)).code).toBe("BL020");
    expect((await refill(F, F.owner, randomUUID())).code).toBe("BL020");
    const refiller = await createMember(F.orgId, "refiller");
    expect((await refill(F, F.owner, refiller.id)).ok).toBe(true);
  });

  it("en nedgraderad admin förlorar sina obesvarade inbjudningar", async () => {
    const admin = await createMember(F.orgId, "admin");
    const invitee = await createUser(`inbjuden-${uniqueSuffix()}@test.binderlab.se`);
    const { token } = await asUser(admin, (tx) =>
      one<{ token: string }>(
        tx,
        sql`select public.create_invitation(${F.orgId}, ${invitee.email}, 'admin') as token`,
      ),
    );
    await asUser(F.owner, (tx) =>
      tx.execute(
        sql`update public.memberships set role = 'viewer'
            where organization_id = ${F.orgId} and user_id = ${admin.id}`,
      ),
    );
    const outcome = await asUser(invitee, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`select public.accept_invitation(${token})`)),
    );
    expect(outcome.code).toBe("BL012");
  });

  it("en ägare som blir admin förlorar bara sina ägarinbjudningar", async () => {
    const fx = await seedTenantFixture();
    const second = await createMember(fx.orgId, "owner");
    const ownerInvitee = await createUser(`agare-${uniqueSuffix()}@test.binderlab.se`);
    const viewerInvitee = await createUser(`lasare-${uniqueSuffix()}@test.binderlab.se`);
    const tokens = await asUser(second, async (tx) => ({
      owner: (
        await one<{ t: string }>(
          tx,
          sql`select public.create_invitation(${fx.orgId}, ${ownerInvitee.email}, 'owner') as t`,
        )
      ).t,
      viewer: (
        await one<{ t: string }>(
          tx,
          sql`select public.create_invitation(${fx.orgId}, ${viewerInvitee.email}, 'viewer') as t`,
        )
      ).t,
    }));
    await asUser(fx.owner, (tx) =>
      tx.execute(
        sql`update public.memberships set role = 'admin'
            where organization_id = ${fx.orgId} and user_id = ${second.id}`,
      ),
    );
    const accept = (user: TestUser, token: string) =>
      asUser(user, (tx) =>
        attempt(tx, (sp) => sp.execute(sql`select public.accept_invitation(${token})`)),
      );
    expect((await accept(ownerInvitee, tokens.owner)).code).toBe("BL012");
    expect((await accept(viewerInvitee, tokens.viewer)).ok).toBe(true);
  });
});

describe("tidszon och stängda månader", () => {
  it("tidszonen kan inte ändras av en klient när det finns stängda månader", async () => {
    const outcome = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.organizations set timezone = 'Europe/Helsinki' where id = ${F.orgId}`,
        ),
      ),
    );
    expect(outcome.code).toBe("BL004");
  });

  it("utan stängda månader går det bra", async () => {
    const owner = await createUser();
    const orgId = await createOrg(owner, "Tidszon");
    const outcome = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.organizations set timezone = 'Europe/Helsinki' where id = ${orgId}`,
        ),
      ),
    );
    expect(outcome.ok).toBe(true);
  });
});

describe("kontroller som flyttats efter RLS fungerar fortfarande", () => {
  it("automatgränsen: den nya automaten räknas, arkiverade gör det inte", async () => {
    const fx = await seedTenantFixture();
    await asPostgres((tx) =>
      tx.execute(sql`update public.organizations set machine_limit = 2 where id = ${fx.orgId}`),
    );
    const add = (code: string) =>
      asUser(fx.owner, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`insert into public.machines (organization_id, code, name)
                values (${fx.orgId}, ${code}, 'Extra')`,
          ),
        ),
      );
    expect((await add("M-2")).ok).toBe(true);
    const third = await add("M-3");
    expect(third.code).toBe("BL019");
    await asUser(fx.owner, (tx) =>
      tx.execute(
        sql`update public.machines set archived_at = now()
            where organization_id = ${fx.orgId} and code = 'M-2'`,
      ),
    );
    expect((await add("M-3")).ok).toBe(true);
  });

  it("en läsare i den egna organisationen får ett rent RLS-nej på order (inte 22023)", async () => {
    const viewer = await createMember(F.orgId, "viewer");
    const outcome = await asUser(viewer, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title,
                ordered_at, business_date, amount_ore, source_hash)
              values (${F.orgId}, ${F.dataSourceId}, ${`x-${uniqueSuffix()}`}, 'x',
                '2025-05-01T23:30:00Z', '2000-01-01', 1, 'h')`,
        ),
      ),
    );
    expect(outcome.code).toBe("42501");
    expect(outcome.message).toContain("row-level security");
  });

  it("påfyllaren får ett rent RLS-nej (inte BL004) för en otillåten typ i en stängd månad", async () => {
    const refiller = await createMember(F.orgId, "refiller");
    const outcome = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.stock_events
                (organization_id, location_id, title_id, kind, quantity, occurred_at)
              values (${F.orgId}, ${F.centralLocationId}, ${F.titleId}, 'adjustment', 1,
                      '2024-12-15T12:00:00Z')`,
        ),
      ),
    );
    expect(outcome.code).toBe("42501");
  });
});
