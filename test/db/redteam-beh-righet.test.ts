/**
 * Röd granskning av behörigheterna i databasen.
 *
 * Varje test beskriver det KORREKTA beteendet: det passerar när systemet är
 * säkert och fallerar om hålet finns. Angreppen görs som riktiga klienter
 * (rollen authenticated med JWT-claims, precis som PostgREST), aldrig som
 * databasägaren.
 *
 * Områden:
 *   1. Påfyllaren försöker härleda ekonomi (belopp, inköpspriser, perioder).
 *   2. En utomstående (medlem i en annan organisation) försöker läsa data via
 *      security definer-triggers som körs före RLS.
 *   3. Admin och läsare försöker höja roller, skapa ägare och ta bort den
 *      sista ägaren (även med samtidiga transaktioner).
 *   4. Inbjudningar: återanvändning, kapning och att admin slår ut en
 *      ägarinbjudan.
 *   5. Stängda månader och RPC:er med en annan organisations id.
 *   6. Ändringsloggen och security definer-funktioner i schemat private.
 */

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
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
  createOrg,
  createUser,
  db,
  one,
  rows,
  seedTenantFixture,
  settle,
  uniqueSuffix,
  type TenantFixture,
  type TestUser,
} from "./helpers";

let F: TenantFixture;
let refiller: TestUser;
let viewer: TestUser;
let admin: TestUser;
/** Ägare av en helt annan organisation (ingen koppling till F). */
let outsider: TestUser;
let outsiderOrgId: string;

beforeAll(async () => {
  F = await seedTenantFixture();
  refiller = await createMember(F.orgId, "refiller");
  viewer = await createMember(F.orgId, "viewer");
  admin = await createMember(F.orgId, "admin");
  outsider = await createUser(`outsider-${uniqueSuffix()}@test.binderlab.se`);
  outsiderOrgId = await createOrg(outsider, "Konkurrenten");
});

async function count(user: TestUser, query: SQL): Promise<number> {
  const { n } = await asUser(user, (tx) => one<{ n: number }>(tx, query));
  return n;
}

/** Kör en sats som användaren och returnerar SQLSTATE (eller "ok"). */
async function codeOf(user: TestUser, query: SQL): Promise<string> {
  const outcome = await asUser(user, (tx) => attempt(tx, (sp) => sp.execute(query)));
  return outcome.ok ? "ok" : outcome.code;
}

/** Som användaren i en egen transaktion med valfri isoleringsnivå. */
function asUserIn<T>(
  user: TestUser,
  isolationLevel: "read committed" | "repeatable read",
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const jwt = JSON.stringify({
    sub: user.id,
    email: user.email,
    role: "authenticated",
    aud: "authenticated",
  });
  return db().transaction(
    async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claims', ${jwt}, true)`);
      await tx.execute(sql`set local role authenticated`);
      return fn(tx);
    },
    { isolationLevel },
  );
}

// ---------------------------------------------------------------------------
// 1. Påfyllaren försöker härleda ekonomi
// ---------------------------------------------------------------------------
describe("påfyllaren försöker härleda ekonomi", () => {
  it("får inga belopp via joins från lagerhändelser till order, priser eller avtal", async () => {
    // Påfyllaren ser försäljningen (order_id) men joinen mot det som bär belopp ska vara tom.
    const sales = await count(
      refiller,
      sql`select count(*)::int as n from public.stock_events
          where organization_id = ${F.orgId} and kind = 'sale'`,
    );
    expect(sales).toBeGreaterThan(0);
    const joined = await count(
      refiller,
      sql`select count(*)::int as n
          from public.stock_events e
          join public.orders o on o.organization_id = e.organization_id and o.id = e.order_id
          where e.organization_id = ${F.orgId}`,
    );
    expect(joined).toBe(0);
    const priced = await count(
      refiller,
      sql`select count(*)::int as n
          from public.stock_events e
          join public.purchase_price_periods p
            on p.organization_id = e.organization_id and p.title_id = e.title_id
          where e.organization_id = ${F.orgId}`,
    );
    expect(priced).toBe(0);
    const terms = await count(
      refiller,
      sql`select count(*)::int as n
          from public.machine_placements mp
          join public.store_agreements a
            on a.organization_id = mp.organization_id and a.store_id = mp.store_id
          where mp.organization_id = ${F.orgId}`,
    );
    expect(terms).toBe(0);
  });

  it("får inga aggregat över ekonomiska tabeller (summor är null/0)", async () => {
    const result = await asUser(refiller, (tx) =>
      one<{ revenue: string | null; cogs: string | null; po: string | null; si: string | null }>(
        tx,
        sql`select
              (select sum(amount_ore) from public.orders where organization_id = ${F.orgId})::text as revenue,
              (select sum(unit_cost_ore) from public.purchase_price_periods where organization_id = ${F.orgId})::text as cogs,
              (select sum(unit_cost_ore) from public.purchase_order_lines where organization_id = ${F.orgId})::text as po,
              (select sum(unit_cost_ore) from public.supplier_items where organization_id = ${F.orgId})::text as si`,
      ),
    );
    expect(result).toEqual({ revenue: null, cogs: null, po: null, si: null });
  });

  it("ser inte ändringsloggen, inte ens för sina egna lagerhändelser", async () => {
    await asUser(refiller, (tx) =>
      tx.insert(s.stockEvents).values({
        organizationId: F.orgId,
        locationId: F.machineLocationId,
        titleId: F.titleId,
        kind: "refill",
        quantity: 3,
        performedBy: refiller.id,
      }),
    );
    const audit = await count(
      refiller,
      sql`select count(*)::int as n from public.audit_log where organization_id = ${F.orgId}`,
    );
    expect(audit).toBe(0);
  });

  it("kan inte köra RPC:er som räknar eller exponerar ekonomi", async () => {
    const calls = [
      sql`select public.close_period(${F.orgId}, '2025-03-01'::date)`,
      sql`select public.reopen_period(${F.orgId}, '2024-12-01'::date)`,
      sql`select public.merge_titles(${F.orgId}, ${F.secondTitleId}, ${F.titleId})`,
      sql`select public.create_invitation(${F.orgId}, 'x@test.binderlab.se', 'viewer')`,
    ];
    for (const call of calls) {
      expect(await codeOf(refiller, call)).toBe("42501");
    }
  });

  it("kan inte skapa en sale-händelse eller koppla en order till sin egen händelse", async () => {
    const base = sql`${F.orgId}, ${F.machineLocationId}, ${F.titleId}`;
    expect(
      await codeOf(
        refiller,
        sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, order_id, performed_by)
            values (${base}, 'sale', -1, ${F.orderIds[0]!}, ${refiller.id})`,
      ),
    ).toBe("42501");
    // order_id på en påfyllning: villkoret stoppar (och FK:n mot orders nås aldrig).
    expect(
      await codeOf(
        refiller,
        sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, order_id, performed_by)
            values (${base}, 'refill', 1, ${F.orderIds[0]!}, ${refiller.id})`,
      ),
    ).toBe("23514");
    expect(
      await codeOf(
        refiller,
        sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, performed_by)
            values (${base}, 'receipt', 1, ${refiller.id})`,
      ),
    ).toBe("42501");
    expect(
      await codeOf(
        refiller,
        sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, performed_by)
            values (${base}, 'adjustment', 1, ${refiller.id})`,
      ),
    ).toBe("42501");
  });

  // HÅL: private.purchase_prices_period_guard (security definer, BEFORE INSERT)
  // körs före RLS:s WITH CHECK. Påfyllarens insert ger BL004 eller 42501
  // beroende på om titeln har ett senare inköpspris före en stängd månad. Det
  // läcker när priserna ändrats (och vilka månader som är stängda).
  it("kan inte avgöra när inköpspriser ändrats via felkoden från en insert", async () => {
    // Egen organisation: titeln har pris från 2025-01-01 och 2025-04-15, juni 2025 är stängd.
    const owner = await createUser();
    const orgId = await createOrg(owner, "Prisorakel");
    const titleId = await asUser(owner, async (tx) => {
      const [title] = await tx
        .insert(s.titles)
        .values({ organizationId: orgId, name: "Prisorakel-titel" })
        .returning();
      await tx.insert(s.purchasePrices).values([
        { organizationId: orgId, titleId: title!.id, unitCostOre: 4500, validFrom: "2025-01-01" },
        { organizationId: orgId, titleId: title!.id, unitCostOre: 4900, validFrom: "2025-04-15" },
      ]);
      await tx.execute(sql`select public.close_period(${orgId}, '2025-06-01'::date)`);
      return title!.id;
    });
    const spy = await createMember(orgId, "refiller");
    const insert = (validFrom: string) =>
      sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
          values (${orgId}, ${titleId}, 1, ${validFrom}::date)`;
    // 2025-04-01: nästa pris (2025-04-15) avslutar intervallet före juni.
    // 2025-05-01: inget senare pris, intervallet går in i juni.
    // Svaret får inte bero på det: båda ska nekas av RLS.
    const before = await codeOf(spy, insert("2025-04-01"));
    const after = await codeOf(spy, insert("2025-05-01"));
    expect({ before, after }).toEqual({ before: "42501", after: "42501" });
  });
});

// ---------------------------------------------------------------------------
// 2. Utomstående: security definer-triggers som körs före RLS
// ---------------------------------------------------------------------------
describe("en utomstående (ägare i en annan organisation) kan inte läsa via triggers", () => {
  // HÅL: alla BEFORE-triggers som är security definer (perioder, automatgräns,
  // affärsdatum) läser den ANDRA organisationens data innan RLS nekar. Felkoden
  // och meddelandet avslöjar det. Den som bara känner till organisationens id
  // (inga titlar, inga rader) ska få 42501 och inget annat.

  it("stängda månader läcker inte via inköpspriser (BL004 i stället för 42501)", async () => {
    const code = await codeOf(
      outsider,
      sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
          values (${F.orgId}, ${randomUUID()}, 1, '2024-12-15'::date)`,
    );
    expect(code).toBe("42501");
  });

  it("stängda månader läcker inte via lagerhändelser", async () => {
    const code = await codeOf(
      outsider,
      sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by)
          values (${F.orgId}, ${randomUUID()}, ${randomUUID()}, 'refill', 1, '2024-12-15T12:00:00Z', ${outsider.id})`,
    );
    expect(code).toBe("42501");
  });

  it("stängda månader läcker inte via avtal och placeringar", async () => {
    for (const table of ["store_agreements", "machine_placements"] as const) {
      const query =
        table === "store_agreements"
          ? sql`insert into public.store_agreements (organization_id, store_id, valid_from, valid_to, commission_bp)
                values (${F.orgId}, ${randomUUID()}, '2024-12-01', '2024-12-31', 1)`
          : sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from, valid_to)
                values (${F.orgId}, ${randomUUID()}, ${randomUUID()}, '2024-12-01', '2024-12-31')`;
      expect({ table, code: await codeOf(outsider, query) }).toEqual({ table, code: "42501" });
    }
  });

  it("automatgränsen läcker inte (BL019 med gränsen i meddelandet i stället för 42501)", async () => {
    const owner = await createUser();
    const orgId = await createOrg(owner, "Liten operatör");
    await asPostgres((tx) =>
      tx.execute(sql`update public.organizations set machine_limit = 0 where id = ${orgId}`),
    );
    const outcome = await asUser(outsider, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.machines (organization_id, code, name) values (${orgId}, 'X-1', 'Spion')`,
        ),
      ),
    );
    // Triggern låser dessutom den andra organisationens rad (select ... for update)
    // innan RLS nekar.
    expect({ code: outcome.code, message: outcome.message }).toMatchObject({ code: "42501" });
  });

  it("organisationens tidszon läcker inte via business_date-kontrollen på order", async () => {
    const outcome = await asUser(outsider, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title, ordered_at, business_date, amount_ore, source_hash)
              values (${F.orgId}, ${randomUUID()}, 'x', 'x', '2025-03-10T23:30:00Z', '2000-01-01', 1, 'x')`,
        ),
      ),
    );
    expect(outcome.code).toBe("42501");
    expect(outcome.message ?? "").not.toContain("Europe/Stockholm");
  });

  it("ser inga rader i F:s organisation via vyerna", async () => {
    for (const view of ["stock_levels", "warehouse_stock", "purchase_price_periods"]) {
      const n = await count(
        outsider,
        sql`select count(*)::int as n from ${sql.identifier("public")}.${sql.identifier(view)}
            where organization_id = ${F.orgId}`,
      );
      expect({ view, n }).toEqual({ view, n: 0 });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Rollhöjning, ägare och sista ägaren
// ---------------------------------------------------------------------------
describe("admin och läsare försöker höja roller", () => {
  it("admin kan inte göra sig till ägare via upsert (insert ... on conflict do update)", async () => {
    const own = await codeOf(
      admin,
      sql`insert into public.memberships (organization_id, user_id, role)
          values (${F.orgId}, ${admin.id}, 'owner')
          on conflict (organization_id, user_id) do update set role = excluded.role`,
    );
    expect(["42501", "BL006"]).toContain(own);
    const ownerRow = await codeOf(
      admin,
      sql`insert into public.memberships (organization_id, user_id, role)
          values (${F.orgId}, ${F.owner.id}, 'viewer')
          on conflict (organization_id, user_id) do update set role = 'viewer'`,
    );
    expect(["42501", "BL006"]).toContain(ownerRow);
    const roles = await rows<{ user_id: string; role: string }>(
      db(),
      sql`select user_id, role::text from public.memberships
          where organization_id = ${F.orgId} and user_id in (${admin.id}, ${F.owner.id})`,
    );
    expect(Object.fromEntries(roles.map((r) => [r.user_id, r.role]))).toEqual({
      [admin.id]: "admin",
      [F.owner.id]: "owner",
    });
  });

  it("admin kan inte ge en annan admin ägarrollen", async () => {
    const other = await createMember(F.orgId, "admin");
    const code = await codeOf(
      admin,
      sql`update public.memberships set role = 'owner'
          where organization_id = ${F.orgId} and user_id = ${other.id}`,
    );
    expect(["42501", "BL006"]).toContain(code);
  });

  it("läsaren kan inte skriva medlemskap, profiler åt andra eller inköpspriser", async () => {
    const stranger = await createUser();
    expect(
      await codeOf(
        viewer,
        sql`insert into public.memberships (organization_id, user_id, role)
            values (${F.orgId}, ${stranger.id}, 'viewer')`,
      ),
    ).toBe("42501");
    expect(
      await codeOf(
        viewer,
        sql`insert into public.profiles (organization_id, user_id, display_name)
            values (${F.orgId}, ${stranger.id}, 'Falsk')`,
      ),
    ).toBe("42501");
    expect(
      await codeOf(
        viewer,
        sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
            values (${F.orgId}, ${F.titleId}, 1, '2026-01-01')`,
      ),
    ).toBe("42501");
    const changed = await asUser(viewer, (tx) =>
      affected(
        tx,
        sql`update public.profiles set display_name = 'Ägaren (falsk)'
            where organization_id = ${F.orgId} and user_id = ${F.owner.id}`,
      ),
    );
    expect(changed).toBe(0);
  });

  it("ingen klient kan ändra plan eller automatgräns (kolumnrättigheter)", async () => {
    for (const user of [F.owner, admin]) {
      expect(
        await codeOf(
          user,
          sql`update public.organizations set plan = 'enterprise' where id = ${F.orgId}`,
        ),
      ).toBe("42501");
      expect(
        await codeOf(
          user,
          sql`update public.organizations set machine_limit = null where id = ${F.orgId}`,
        ),
      ).toBe("42501");
    }
  });

  it("organisationer och medlemskap kan inte skapas direkt i tabellerna i en annan organisation", async () => {
    expect(
      await codeOf(
        outsider,
        sql`insert into public.memberships (organization_id, user_id, role)
            values (${F.orgId}, ${outsider.id}, 'owner')`,
      ),
    ).toBe("42501");
    expect(
      await codeOf(
        outsider,
        sql`insert into public.organizations (name, slug) values ('x', ${`x-${uniqueSuffix()}`})`,
      ),
    ).toBe("42501");
  });

  it("ägaren kan inte ta bort sig själv som sista ägare, inte heller via upsert", async () => {
    const fx = await seedTenantFixture();
    const code = await codeOf(
      fx.owner,
      sql`insert into public.memberships (organization_id, user_id, role)
          values (${fx.orgId}, ${fx.owner.id}, 'viewer')
          on conflict (organization_id, user_id) do update set role = excluded.role`,
    );
    expect(code).toBe("BL005");
  });

  // HÅL: private.memberships_keep_owner låser organisationsraden men räknar
  // ägarna med transaktionens ögonblicksbild. Under REPEATABLE READ (eller
  // SERIALIZABLE utan SSI-konflikt på just de raderna) ser den andra
  // transaktionen inte den första degraderingen, och båda går igenom.
  it("två ägare som samtidigt degraderar varandra lämnar minst en ägare (repeatable read)", async () => {
    const owner1 = await createUser();
    const orgId = await createOrg(owner1, "Kapplöpning");
    // Justerat av byggagenten: medlemskap skapas bara via inbjudan (HÅL 5 i
    // redteam-isolering), så ägare 2 läggs in av systemet i stället för med en
    // direkt insert av ägare 1. Själva testet (samtidig degradering) är orört.
    const owner2 = await createMember(orgId, "owner");

    let snapshotTaken!: () => void;
    const t2Snapshot = new Promise<void>((resolve) => {
      snapshotTaken = resolve;
    });
    let continueT2!: () => void;
    const t2Go = new Promise<void>((resolve) => {
      continueT2 = resolve;
    });

    // T2 (ägare 2) tar sin ögonblicksbild först ...
    const t2 = settle(
      asUserIn(owner2, "repeatable read", async (tx) => {
        await tx.execute(
          sql`select count(*) from public.memberships where organization_id = ${orgId}`,
        );
        snapshotTaken();
        await t2Go;
        await tx.execute(
          sql`update public.memberships set role = 'admin'
              where organization_id = ${orgId} and user_id = ${owner1.id}`,
        );
      }),
    );
    await t2Snapshot;
    // ... T1 (ägare 1) degraderar ägare 2 och committar ...
    await asUserIn(owner1, "repeatable read", (tx) =>
      tx.execute(
        sql`update public.memberships set role = 'admin'
            where organization_id = ${orgId} and user_id = ${owner2.id}`,
      ),
    );
    // ... och T2 degraderar ägare 1.
    continueT2();
    const outcome = await t2;

    const owners = await rows(
      db(),
      sql`select user_id from public.memberships where organization_id = ${orgId} and role = 'owner'`,
    );
    expect({ t2: outcome.ok ? "ok" : outcome.code, owners: owners.length }).toEqual({
      t2: expect.stringMatching(/^(BL005|40001)$/),
      owners: 1,
    });
  });

  it("två ägare som samtidigt degraderar varandra lämnar minst en ägare (read committed)", async () => {
    const owner1 = await createUser();
    const orgId = await createOrg(owner1, "Kapplöpning RC");
    // Justerat av byggagenten: medlemskap skapas bara via inbjudan (HÅL 5 i
    // redteam-isolering), så ägare 2 läggs in av systemet i stället för med en
    // direkt insert av ägare 1. Själva testet (samtidig degradering) är orört.
    const owner2 = await createMember(orgId, "owner");
    let t1Updated!: () => void;
    const t1Ready = new Promise<void>((resolve) => {
      t1Updated = resolve;
    });
    let commitT1!: () => void;
    const t1Commit = new Promise<void>((resolve) => {
      commitT1 = resolve;
    });
    const t1 = settle(
      asUserIn(owner1, "read committed", async (tx) => {
        await tx.execute(
          sql`update public.memberships set role = 'admin'
              where organization_id = ${orgId} and user_id = ${owner2.id}`,
        );
        t1Updated();
        await t1Commit;
      }),
    );
    await t1Ready;
    // T2 blockeras på organisationsraden tills T1 committar.
    const t2 = settle(
      asUserIn(owner2, "read committed", (tx) =>
        tx.execute(
          sql`update public.memberships set role = 'admin'
              where organization_id = ${orgId} and user_id = ${owner1.id}`,
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    commitT1();
    const [r1, r2] = await Promise.all([t1, t2]);
    const owners = await rows(
      db(),
      sql`select 1 from public.memberships where organization_id = ${orgId} and role = 'owner'`,
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok ? "ok" : r2.code).toBe("BL005");
    expect(owners).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Inbjudningar
// ---------------------------------------------------------------------------
describe("inbjudningar: återanvändning och kapning", () => {
  async function invite(by: TestUser, email: string, role: string): Promise<string> {
    const { token } = await asUser(by, (tx) =>
      one<{ token: string }>(
        tx,
        sql`select public.create_invitation(${F.orgId}, ${email}, ${role}::public.member_role) as token`,
      ),
    );
    return token;
  }

  async function accept(user: TestUser, token: string, emailClaim?: string | null) {
    const claims = JSON.stringify({
      sub: user.id,
      ...(emailClaim === null ? {} : { email: emailClaim ?? user.email }),
      role: "authenticated",
    });
    return db().transaction(async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
      await tx.execute(sql`set local role authenticated`);
      return attempt(tx, (sp) =>
        one<{ org: string }>(sp, sql`select public.accept_invitation(${token}) as org`),
      );
    });
  }

  it("en använd inbjudan kan inte användas igen efter att medlemskapet tagits bort", async () => {
    const user = await createUser();
    const token = await invite(F.owner, user.email, "admin");
    expect((await accept(user, token)).ok).toBe(true);
    await asUser(F.owner, (tx) =>
      tx.execute(
        sql`delete from public.memberships where organization_id = ${F.orgId} and user_id = ${user.id}`,
      ),
    );
    expect((await accept(user, token)).code).toBe("BL011");
  });

  it("kan inte kapas: utan e-post i JWT, med annan e-post eller av en annan användare", async () => {
    const victim = `offer-${uniqueSuffix()}@test.binderlab.se`;
    const token = await invite(F.owner, victim, "admin");
    const attacker = await createUser();
    expect((await accept(attacker, token, null)).code).toBe("BL013");
    expect((await accept(attacker, token, "")).code).toBe("BL013");
    expect((await accept(attacker, token, `${victim} `)).code).toBe("BL013");
    expect((await accept(attacker, token, `x${victim}`)).code).toBe("BL013");
    // Hashen (som admin kan läsa) fungerar inte som token.
    const { token_hash } = await one<{ token_hash: string }>(
      db(),
      sql`select token_hash from public.invitations where organization_id = ${F.orgId} and email = ${victim}`,
    );
    expect((await accept(attacker, token_hash, victim)).code).toBe("BL010");
    const members = await rows(
      db(),
      sql`select 1 from public.memberships where organization_id = ${F.orgId} and user_id = ${attacker.id}`,
    );
    expect(members).toHaveLength(0);
  });

  it("admin kan inte radera en ägarinbjudan", async () => {
    const email = `blivande-agare-${uniqueSuffix()}@test.binderlab.se`;
    await invite(F.owner, email, "owner");
    const removed = await asUser(admin, (tx) =>
      affected(
        tx,
        sql`delete from public.invitations where organization_id = ${F.orgId} and email = ${email}`,
      ),
    );
    expect(removed).toBe(0);
  });

  // HÅL: create_invitation låter en admin bjuda in samma adress igen, och då
  // sätts ALLA obesvarade inbjudningar till adressen som utgångna, även en
  // ägarinbjudan som admin inte får radera (invitations_delete kräver
  // role <> 'owner' för admin). Admin kan alltså slå ut eller "nedgradera"
  // ägarens inbjudan.
  it("admin kan inte ogiltigförklara ägarens ägarinbjudan genom att bjuda in samma adress", async () => {
    const invitee = await createUser(`agare-${uniqueSuffix()}@test.binderlab.se`);
    const ownerToken = await invite(F.owner, invitee.email, "owner");
    await asUser(admin, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.create_invitation(${F.orgId}, ${invitee.email}, 'viewer'::public.member_role)`,
        ),
      ),
    );
    const outcome = await accept(invitee, ownerToken);
    expect(outcome.ok ? "ok" : outcome.code).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 5. Stängda månader och RPC:er med en annan organisations id
// ---------------------------------------------------------------------------
describe("stängda månader och security definer-RPC:er", () => {
  it("ägaren i en annan organisation kan inte köra någon RPC mot F", async () => {
    const calls = {
      close_period: sql`select public.close_period(${F.orgId}, '2025-02-01'::date)`,
      reopen_period: sql`select public.reopen_period(${F.orgId}, '2024-12-01'::date)`,
      create_invitation: sql`select public.create_invitation(${F.orgId}, ${outsider.email}, 'owner')`,
      merge_titles: sql`select public.merge_titles(${F.orgId}, ${F.secondTitleId}, ${F.titleId})`,
    };
    for (const [name, call] of Object.entries(calls)) {
      expect({ name, code: await codeOf(outsider, call) }).toEqual({ name, code: "42501" });
    }
  });

  it("merge_titles i den egna organisationen kan inte peka på en annan organisations titlar", async () => {
    const [own] = await asUser(outsider, (tx) =>
      tx
        .insert(s.titles)
        .values({ organizationId: outsiderOrgId, name: `Egen ${uniqueSuffix()}` })
        .returning(),
    );
    const code = await codeOf(
      outsider,
      sql`select public.merge_titles(${outsiderOrgId}, ${F.titleId}, ${own!.id})`,
    );
    expect(code).toBe("22023");
    const { merged } = await one<{ merged: string | null }>(
      db(),
      sql`select merged_into_id as merged from public.titles where id = ${F.titleId}`,
    );
    expect(merged).toBeNull();
  });

  it("admin och läsare kan inte öppna en stängd månad, varken via RPC eller direkt", async () => {
    for (const user of [admin, viewer]) {
      expect(
        await codeOf(user, sql`select public.reopen_period(${F.orgId}, '2024-12-01'::date)`),
      ).toBe("42501");
      expect(
        await codeOf(
          user,
          sql`update public.period_closes set reopened_at = now() where organization_id = ${F.orgId}`,
        ),
      ).toBe("42501");
      expect(
        await codeOf(
          user,
          sql`delete from public.period_closes where organization_id = ${F.orgId}`,
        ),
      ).toBe("42501");
    }
    const open = await rows(
      db(),
      sql`select 1 from public.period_closes
          where organization_id = ${F.orgId} and month = '2024-12-01' and reopened_at is null`,
    );
    expect(open).toHaveLength(1);
  });

  it("läsaren kan inte stänga en månad (och inte få databasens sammanfattning skriven)", async () => {
    expect(
      await codeOf(viewer, sql`select public.close_period(${F.orgId}, '2025-01-01'::date)`),
    ).toBe("42501");
  });

  it("admin kan inte ändra inköpspriset för en stängd månad genom att flytta giltighetsdatumet", async () => {
    // Priset från 2025-01-01 gäller inte i december; att flytta det bakåt in i
    // den stängda månaden ska nekas.
    const code = await codeOf(
      admin,
      sql`update public.purchase_prices set valid_from = '2024-12-10'
          where organization_id = ${F.orgId} and title_id = ${F.secondTitleId} and valid_from = '2025-01-01'`,
    );
    expect(code).toBe("BL004");
  });
});

// ---------------------------------------------------------------------------
// 6. Ändringsloggen och schemat private
// ---------------------------------------------------------------------------
describe("ändringsloggen", () => {
  it("ingen klient (inte ens ägaren eller service_role) kan skriva, ändra eller tömma den", async () => {
    const forged = sql`insert into public.audit_log (organization_id, table_name, row_id, action, actor_id, after)
                       values (${F.orgId}, 'purchase_prices', ${randomUUID()}, 'insert', ${admin.id}, '{}'::jsonb)`;
    expect(await codeOf(F.owner, forged)).toBe("42501");
    expect(
      await codeOf(
        F.owner,
        sql`update public.audit_log set actor_id = null where organization_id = ${F.orgId}`,
      ),
    ).toBe("42501");
    expect(
      await codeOf(F.owner, sql`delete from public.audit_log where organization_id = ${F.orgId}`),
    ).toBe("42501");
    expect(await codeOf(F.owner, sql`truncate public.audit_log`)).toBe("42501");
    for (const query of [
      forged,
      sql`update public.audit_log set actor_id = null where organization_id = ${F.orgId}`,
      sql`delete from public.audit_log where organization_id = ${F.orgId}`,
    ]) {
      const outcome = await asServiceRole((tx) => attempt(tx, (sp) => sp.execute(query)));
      expect(outcome.code).toBe("42501");
    }
  });

  it("aktören kan inte förfalskas: en prisändring loggas med den som gjorde den", async () => {
    const [price] = await asUser(admin, (tx) =>
      tx
        .insert(s.purchasePrices)
        .values({
          organizationId: F.orgId,
          titleId: F.secondTitleId,
          unitCostOre: 5300,
          validFrom: "2026-06-01",
          createdBy: F.owner.id,
        })
        .returning(),
    );
    const log = await one<{ actor_id: string; created_by: string }>(
      db(),
      sql`select actor_id, after ->> 'created_by' as created_by from public.audit_log
          where organization_id = ${F.orgId} and table_name = 'purchase_prices' and row_id = ${price!.id}`,
    );
    expect(log).toEqual({ actor_id: admin.id, created_by: admin.id });
  });

  it("läsaren ser inte medlems- och inbjudningshändelser", async () => {
    const n = await count(
      viewer,
      sql`select count(*)::int as n from public.audit_log
          where organization_id = ${F.orgId} and table_name in ('memberships', 'invitations')`,
    );
    expect(n).toBe(0);
    const total = await count(
      viewer,
      sql`select count(*)::int as n from public.audit_log where organization_id = ${F.orgId}`,
    );
    expect(total).toBeGreaterThan(0);
  });
});

describe("security definer-funktioner i private", () => {
  it("klienter kan inte skapa objekt i public eller private (ingen search_path-kapning)", async () => {
    expect(
      await codeOf(
        F.owner,
        sql`create function public.has_role(uuid) returns boolean language sql as 'select true'`,
      ),
    ).toBe("42501");
    expect(await codeOf(F.owner, sql`create table private.x (id int)`)).toBe("42501");
  });

  it("has_role och orgs_with_role svarar bara om den inloggade själv", async () => {
    const result = await asUser(outsider, (tx) =>
      one<{ has: boolean; orgs: string[] }>(
        tx,
        sql`select private.has_role(${F.orgId}, 'owner', 'admin', 'refiller', 'viewer') as has,
                   array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))::text[] as orgs`,
      ),
    );
    expect(result).toEqual({ has: false, orgs: [outsiderOrgId] });
  });

  it("interna hjälpfunktioner (perioder, priser, auth.users) kan inte anropas direkt", async () => {
    const calls = [
      sql`select private.closed_months(${F.orgId})`,
      sql`select private.is_closed_day(${F.orgId}, '2024-12-15'::date)`,
      sql`select private.price_effective_range(${F.orgId}, ${F.titleId}, '2024-01-01'::date, null)`,
      sql`select private.user_exists(${F.owner.id})`,
      sql`select private.assert_period_open(${F.orgId}, '{[2024-12-01,2024-12-02)}'::datemultirange, 'x')`,
    ];
    for (const call of calls) {
      expect(await codeOf(outsider, call)).toBe("42501");
    }
  });

  // HÅL (lågt): private.is_actor_anonymization är security definer, körbar av
  // authenticated och anropar private.user_exists. Utanför en trigger blir den
  // ett orakel för om ett godtyckligt uuid finns i auth.users (t.ex. om en
  // användare i en annan organisation har raderats).
  it("is_actor_anonymization kan inte användas som orakel för auth.users", async () => {
    const probe = (userId: string) =>
      asUser(outsider, (tx) =>
        attempt(tx, (sp) =>
          one<{ v: boolean }>(
            sp,
            sql`select private.is_actor_anonymization(
                  jsonb_build_object('created_by', ${userId}::text),
                  '{"created_by": null}'::jsonb) as v`,
          ),
        ),
      );
    const existing = await probe(F.owner.id);
    const missing = await probe(randomUUID());
    const answer = (o: typeof existing) => (o.ok ? String(o.value.v) : o.code);
    // Antingen nekas anropet, eller så ger det samma svar oavsett om användaren finns.
    expect(answer(existing) === "42501" || answer(existing) === answer(missing)).toBe(true);
  });
});
