/**
 * Röd granskning: isolering mellan organisationer och behörigheter.
 *
 * Varje test uttrycker det KORREKTA beteendet: det passerar när databasen är
 * säker och fallerar om hålet finns. Angriparen är ägare (eller admin) i
 * organisation A och försöker läsa, skriva, flytta eller referera data i
 * organisation B, eller lära sig något om B, via tabeller, vyer, RPC:er,
 * triggers, sammansatta FK:er, storage, felmeddelanden, planerarens
 * statistik, globala räknare och lås.
 *
 * Gruppen "HÅL" är fynd (fallerar tills åtgärden är gjord). Gruppen
 * "STOD EMOT" är attacker som systemet klarar i dag och som ska fortsätta
 * att göra det.
 */

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  asPostgres,
  asServiceRole,
  asUser,
  attempt,
  createOrg,
  createUser,
  db,
  one,
  orgScopedTables,
  rel,
  rows,
  sampleRow,
  seedTenantFixture,
  type Outcome,
  type TenantFixture,
  type TestUser,
} from "./helpers";

const scoped = await orgScopedTables();

let A: TenantFixture;
let B: TenantFixture;

beforeAll(async () => {
  A = await seedTenantFixture();
  B = await seedTenantFixture();
  // B:s hemligheter som A inte ska kunna lära sig: tidszon och automatgräns.
  // (Fixturen har en automat och december 2024 stängd.)
  await db().execute(
    sql`update public.organizations set timezone = 'Asia/Tokyo', machine_limit = 1 where id = ${B.orgId}`,
  );
});

/** Kör en sats som A:s ägare i en savepoint och returnerar utfallet. */
function asAttacker(query: SQL, user?: TestUser): Promise<Outcome<unknown>> {
  return asUser(user ?? A.owner, (tx) => attempt(tx, (sp) => sp.execute(query)));
}

/** Ett utfall som inte lär angriparen något: RLS nekar (42501). */
function expectPlainRlsDenial(outcome: Outcome<unknown>, secrets: string[] = []): void {
  expect(outcome.ok, "satsen lyckades").toBe(false);
  expect(
    outcome.code,
    `fel ${outcome.code}: "${outcome.message}" (förväntade ett rent RLS-nej, 42501)`,
  ).toBe("42501");
  for (const secret of secrets) {
    expect(outcome.message).not.toContain(secret);
  }
}

// =============================================================================
// HÅL
// =============================================================================

describe("HÅL 1: BEFORE-triggers körs före RLS och läcker B:s uppgifter i felmeddelanden", () => {
  it("orders: B:s tidszon (och att B finns) avslöjas inte via business_date-kontrollen", async () => {
    const outcome = await asAttacker(
      sql`insert into public.orders
            (organization_id, data_source_id, external_id, raw_title, ordered_at, business_date,
             amount_ore, source_hash)
          values (${B.orgId}, ${randomUUID()}, 'x', 'x', '2025-05-01T20:00:00Z', '2025-05-01', 1, 'h')`,
    );
    expectPlainRlsDenial(outcome, ["Asia/Tokyo", "2025-05-02"]);
  });

  const closedMonthProbes: { table: string; query: () => SQL }[] = [
    {
      table: "stock_events",
      query: () =>
        sql`insert into public.stock_events
              (organization_id, location_id, title_id, kind, quantity, occurred_at)
            values (${B.orgId}, ${randomUUID()}, ${randomUUID()}, 'refill', 1, '2024-12-15T12:00:00Z')`,
    },
    {
      table: "purchase_prices",
      query: () =>
        sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
            values (${B.orgId}, ${B.titleId}, 1, '2024-12-15')`,
    },
    {
      table: "store_agreements",
      query: () =>
        sql`insert into public.store_agreements (organization_id, store_id, valid_from, commission_bp)
            values (${B.orgId}, ${randomUUID()}, '2024-12-15', 1)`,
    },
    {
      table: "machine_placements",
      query: () =>
        sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
            values (${B.orgId}, ${randomUUID()}, ${randomUUID()}, '2024-12-15')`,
    },
  ];

  it.each(closedMonthProbes)(
    "$table: att B har stängt december 2024 avslöjas inte (BL004 före RLS)",
    async ({ query }) => {
      expectPlainRlsDenial(await asAttacker(query()), ["stängd månad", "2024-12"]);
    },
  );

  it("machines: B:s automatgräns avslöjas inte (BL019 före RLS)", async () => {
    const outcome = await asAttacker(
      sql`insert into public.machines (organization_id, code, name)
          values (${B.orgId}, 'X-1', 'Intrång')`,
    );
    expectPlainRlsDenial(outcome, ["högst"]);
  });

  it("machines: ett försök mot B tar inget radlås på B:s organisationsrad (lås-/tidsorakel)", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    // B håller sin organisationsrad låst (som close_period eller en ny automat gör).
    const holder = db().transaction(async (tx) => {
      await tx.execute(sql`select 1 from public.organizations where id = ${B.orgId} for update`);
      signalLocked();
      await hold;
    });
    await locked;
    let outcome: Outcome<unknown>;
    try {
      outcome = await asUser(A.owner, async (tx) => {
        await tx.execute(sql`set local lock_timeout = '300ms'`);
        return attempt(tx, (sp) =>
          sp.execute(
            sql`insert into public.machines (organization_id, code, name)
                values (${B.orgId}, 'X-2', 'Intrång')`,
          ),
        );
      });
    } finally {
      release();
      await holder;
    }
    // 55P03 (lock_not_available) betyder att A:s sats väntade på B:s lås.
    expectPlainRlsDenial(outcome);
  });
});

describe("HÅL 2: den globala sekvensen stock_events.seq", () => {
  it("authenticated har inga rättigheter på sekvenser i public (setval kan stoppa alla organisationers import)", async () => {
    const result = await rows<{ seq: string; usage: boolean; select: boolean; update: boolean }>(
      db(),
      sql`select c.relname as seq,
                 has_sequence_privilege('authenticated', c.oid, 'USAGE') as usage,
                 has_sequence_privilege('authenticated', c.oid, 'SELECT') as select,
                 has_sequence_privilege('authenticated', c.oid, 'UPDATE') as update
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          -- Justerat av byggagenten: stock_events.seq räknas nu per organisation
          -- med sekvenser i private, så public har inga sekvenser kvar. Testet
          -- omfattar därför både public och private (strängare än tidigare).
          where n.nspname in ('public', 'private') and c.relkind = 'S'
          order by 1`,
    );
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      expect({ seq: r.seq, usage: r.usage, select: r.select, update: r.update }).toEqual({
        seq: r.seq,
        usage: false,
        select: false,
        update: false,
      });
    }
  });

  it("A kan inte räkna B:s lagerhändelser (och därmed B:s försäljning) via glappet i seq", async () => {
    const insertOwn = sql`insert into public.stock_events
        (organization_id, location_id, title_id, kind, quantity, occurred_at)
      values (${A.orgId}, ${A.centralLocationId}, ${A.titleId}, 'refill', 1, '2025-05-01T10:00:00Z')
      returning seq::text as seq`;
    const first = await asUser(A.owner, (tx) =>
      attempt(tx, (sp) => one<{ seq: string }>(sp, insertOwn)),
    );
    if (!first.ok) {
      // Kolumnen är inte läsbar för klienter: inget att räkna på.
      expect(first.code).toBe("42501");
      return;
    }
    // B har fem lagerhändelser under tiden.
    await asUser(B.owner, async (tx) => {
      for (let i = 0; i < 5; i += 1) {
        await tx.execute(
          sql`insert into public.stock_events
                (organization_id, location_id, title_id, kind, quantity, occurred_at)
              values (${B.orgId}, ${B.centralLocationId}, ${B.titleId}, 'refill', 1, '2025-05-01T11:00:00Z')`,
        );
      }
    });
    const second = await asUser(A.owner, (tx) => one<{ seq: string }>(tx, insertOwn));
    const gap = BigInt(second.seq) - BigInt(first.value.seq);
    expect(gap, "glappet i seq visar hur många händelser andra organisationer skapat").toBe(1n);
  });
});

describe("HÅL 3: planerarens statistik avslöjar B:s radantal", () => {
  async function estimatedRows(orgId: string): Promise<number> {
    const result = await asUser(A.owner, (tx) =>
      rows<{ "QUERY PLAN": unknown }>(
        tx,
        sql`explain (format json) select * from public.orders where organization_id = ${orgId}::uuid`,
      ),
    );
    const raw = result[0]?.["QUERY PLAN"];
    const plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      Plan: { "Plan Rows": number };
    }[];
    return plan[0]!.Plan["Plan Rows"];
  }

  it("estimatet för B:s organization_id (PostgREST Prefer: count=planned) går inte att skilja från ett okänt id", async () => {
    const BULK = 3000;
    await asPostgres(async (tx) => {
      await tx.execute(
        sql`insert into public.orders
              (organization_id, data_source_id, external_id, raw_title, ordered_at, amount_ore, source_hash)
            select ${B.orgId}, ${B.dataSourceId}, 'bulk-' || g, 'Pokemon 151',
                   '2025-05-01T08:00:00Z'::timestamptz + g * interval '1 minute', 7900, 'h' || g
            from generate_series(1, ${BULK}) g`,
      );
    });
    await db().execute(sql`analyze public.orders`);

    const foreign = await estimatedRows(B.orgId);
    const unknown = await estimatedRows(randomUUID());
    // Med statistik för organization_id blir estimatet för B ≈ B:s verkliga antal.
    expect(
      Math.abs(foreign - unknown),
      `estimat för B: ${foreign}, för ett okänt id: ${unknown} (B har ${BULK + 2} order)`,
    ).toBeLessThanOrEqual(Math.max(10, unknown * 0.1));
  });
});

describe("HÅL 4: sökvägar med '..' (service-vägar som laddar ned via URL)", () => {
  it.each(["imports", "reports"])(
    "%s: storage-policyn godtar inte en sökväg som börjar i A men pekar in i B",
    async (bucket) => {
      const outcome = await asAttacker(
        sql`insert into storage.objects (bucket_id, name, owner)
            values (${bucket}, ${`${A.orgId}/../${B.orgId}/${randomUUID()}.pdf`}, ${A.owner.id})`,
      );
      expect(outcome.ok, "sökvägen med '..' godtogs").toBe(false);
    },
  );

  it.each(["reports", "imports", "contracts"])(
    "%s.storage_path kan inte sättas till A/../B/... (check-villkoret godtar den i dag)",
    async (table) => {
      const row = await sampleRow(table, A.orgId);
      const outcome = await asAttacker(
        sql`update ${rel(table)} set storage_path = ${`${A.orgId}/../${B.orgId}/reports/2025-03.pdf`}
            where id = ${row!.id as string}`,
      );
      expect(outcome.ok, "storage_path med '..' godtogs").toBe(false);
    },
  );
});

describe("HÅL 5: användare från en annan organisation utan samtycke", () => {
  it("A:s ägare kan inte göra B:s ägare till medlem i A utan inbjudan", async () => {
    const outcome = await asAttacker(
      sql`insert into public.memberships (organization_id, user_id, role)
          values (${A.orgId}, ${B.owner.id}, 'owner')`,
    );
    expect(outcome.ok, "B:s ägare blev medlem (ägare) i A utan att ha accepterat något").toBe(
      false,
    );
  });

  it("A:s ägare kan inte skapa en profil i A för en användare som inte är medlem", async () => {
    const outsider = await createUser();
    const outcome = await asAttacker(
      sql`insert into public.profiles (organization_id, user_id, display_name)
          values (${A.orgId}, ${outsider.id}, 'Påhittad')`,
    );
    expect(outcome.ok).toBe(false);
  });

  it("lagerhändelser kan inte tillskrivas en användare som inte är medlem (performed_by)", async () => {
    const outcome = await asAttacker(
      sql`insert into public.stock_events
            (organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by)
          values (${A.orgId}, ${A.centralLocationId}, ${A.titleId}, 'refill', 1,
                  '2025-05-02T10:00:00Z', ${B.owner.id})`,
    );
    expect(outcome.ok, "händelsen sparades i B-ägarens namn").toBe(false);
  });

  it("private.is_actor_anonymization fungerar inte som orakel för vilka användar-id som finns", async () => {
    const probe = (userId: string) =>
      asAttacker(
        sql`select private.is_actor_anonymization(
              jsonb_build_object('created_by', ${userId}::text),
              '{"created_by": null}'::jsonb) as r`,
      );
    const existing = await probe(B.owner.id);
    const missing = await probe(randomUUID());
    const view = (o: Outcome<unknown>) =>
      o.ok ? { ok: true, value: Array.from(o.value as Iterable<unknown>) } : { ok: false };
    expect(view(existing), "svaret skiljer sig för befintlig och okänd användare").toEqual(
      view(missing),
    );
  });
});

describe("HÅL 6: hemlighetsreferenser är inte namnrymda per organisation", () => {
  it("data_sources.secret_ref kan inte peka på en hemlighet i B:s namnrymd", async () => {
    // Vault är gemensamt för hela projektet. Importjobbet (service role) läser
    // hemligheten med namnet i secret_ref och hämtar order till A:s organisation.
    const outcome = await asAttacker(
      sql`update public.data_sources set secret_ref = ${`${B.orgId}/awish_grpc`}
          where id = ${A.dataSourceId}`,
    );
    expect(outcome.ok, "A kunde peka sin datakälla på B:s hemlighet").toBe(false);
  });
});

// =============================================================================
// STOD EMOT
// =============================================================================

describe("STOD EMOT: storage_path måste börja med den egna organisationens id", () => {
  it.each(["reports", "imports", "contracts"])("%s.storage_path = B/... nekas", async (table) => {
    const row = await sampleRow(table, A.orgId);
    const outcome = await asAttacker(
      sql`update ${rel(table)} set storage_path = ${`${B.orgId}/reports/2025-03.pdf`}
          where id = ${row!.id as string}`,
    );
    expect(outcome.code).toBe("23514");
  });
});

describe("STOD EMOT: RPC:er med B:s id", () => {
  it("close_period, reopen_period, create_invitation och merge_titles nekas och ändrar inget", async () => {
    const before = await one<{ closes: number; invites: number; titles: string }>(
      db(),
      sql`select (select count(*)::int from public.period_closes where organization_id = ${B.orgId}) as closes,
                 (select count(*)::int from public.invitations where organization_id = ${B.orgId}) as invites,
                 (select string_agg(id::text || coalesce(merged_into_id::text, ''), ',' order by id)
                    from public.titles where organization_id = ${B.orgId}) as titles`,
    );
    const calls = [
      sql`select public.close_period(${B.orgId}, '2025-01-01'::date)`,
      sql`select public.reopen_period(${B.orgId}, '2024-12-01'::date)`,
      sql`select public.create_invitation(${B.orgId}, 'spion@example.se', 'owner')`,
      sql`select public.merge_titles(${B.orgId}, ${B.secondTitleId}, ${B.titleId})`,
    ];
    for (const call of calls) {
      const outcome = await asAttacker(call);
      expect(outcome.code).toBe("42501");
    }
    const after = await one<typeof before>(
      db(),
      sql`select (select count(*)::int from public.period_closes where organization_id = ${B.orgId}) as closes,
                 (select count(*)::int from public.invitations where organization_id = ${B.orgId}) as invites,
                 (select string_agg(id::text || coalesce(merged_into_id::text, ''), ',' order by id)
                    from public.titles where organization_id = ${B.orgId}) as titles`,
    );
    expect(after).toEqual(before);
  });

  it("merge_titles i A med B:s titel ger samma svar som ett okänt id", async () => {
    const withForeign = await asAttacker(
      sql`select public.merge_titles(${A.orgId}, ${B.titleId}, ${A.titleId})`,
    );
    const withRandom = await asAttacker(
      sql`select public.merge_titles(${A.orgId}, ${randomUUID()}, ${A.titleId})`,
    );
    expect(withForeign.ok).toBe(false);
    expect({ code: withForeign.code, message: withForeign.message }).toEqual({
      code: withRandom.code,
      message: withRandom.message,
    });
  });
});

describe("STOD EMOT: sammansatta FK:er läcker inte om B:s id finns", () => {
  it("ett pris i A för B:s titel ger samma fel som för ett okänt id", async () => {
    const insert = (titleId: string) =>
      asAttacker(
        sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
            values (${A.orgId}, ${titleId}, 100, '2025-06-01')`,
      );
    const foreign = await insert(B.titleId);
    const unknown = await insert(randomUUID());
    expect(foreign.code).toBe("23503");
    expect({ code: foreign.code, message: foreign.message }).toEqual({
      code: unknown.code,
      message: unknown.message,
    });
  });

  it("en lagerflytt i A kan inte använda B:s lagerplats", async () => {
    const group = randomUUID();
    const outcome = await asUser(A.owner, (tx) =>
      attempt(tx, async (sp) => {
        await sp.execute(
          sql`insert into public.stock_events
                (organization_id, location_id, title_id, kind, quantity, occurred_at, transfer_group_id)
              values
                (${A.orgId}, ${A.centralLocationId}, ${A.titleId}, 'transfer_out', -1, '2025-05-03T10:00:00Z', ${group}),
                (${A.orgId}, ${B.centralLocationId}, ${A.titleId}, 'transfer_in', 1, '2025-05-03T10:00:00Z', ${group})`,
        );
      }),
    );
    expect(outcome.code).toBe("23503");
  });
});

describe("STOD EMOT: felbaserade sidokanaler i where-villkor", () => {
  // Om angriparens villkor (som kan kasta fel) utvärderades före RLS skulle
  // division med noll avslöja att en rad från B finns.
  it.each([
    ["orders", sql`amount_ore > 0`],
    ["stock_levels", sql`quantity is not null`],
    ["purchase_price_periods", sql`unit_cost_ore >= 0`],
    ["audit_log", sql`true`],
  ] as const)("%s", async (relation, extra) => {
    const outcome = await asAttacker(
      sql`select count(*) from ${rel(relation)}
          where 1 / (case when organization_id = ${B.orgId}::uuid and ${extra} then 0 else 1 end) = 1`,
    );
    expect(outcome.ok, `${outcome.code} ${outcome.message}`).toBe(true);
  });

  it("pg_stats visar inga värden från tabeller med RLS", async () => {
    const result = await asUser(A.owner, (tx) =>
      one<{ n: number }>(
        tx,
        sql`select count(*)::int as n from pg_stats where schemaname = 'public' and tablename = 'orders'`,
      ),
    );
    expect(result.n).toBe(0);
  });
});

describe("STOD EMOT: roller i flera organisationer blandas inte ihop", () => {
  let dual: TestUser;

  beforeAll(async () => {
    // Ägare i en egen organisation och påfyllare i A.
    dual = await createUser();
    await createOrg(dual, "Dubbelroll");
    await addMember(A.orgId, dual, "refiller");
  });

  it("ägare i en annan organisation + påfyllare i A ser inga order, priser eller ändringslogg från A", async () => {
    const counts = await asUser(dual, (tx) =>
      one<{ orders: number; prices: number; audit: number }>(
        tx,
        sql`select (select count(*)::int from public.orders where organization_id = ${A.orgId}) as orders,
                   (select count(*)::int from public.purchase_prices where organization_id = ${A.orgId}) as prices,
                   (select count(*)::int from public.audit_log where organization_id = ${A.orgId}) as audit`,
      ),
    );
    expect(counts).toEqual({ orders: 0, prices: 0, audit: 0 });
  });

  it("ägare i en annan organisation + påfyllare i A kan inte skapa en försäljning eller justering i A", async () => {
    const outcome = await asAttacker(
      sql`insert into public.stock_events
            (organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by)
          values (${A.orgId}, ${A.centralLocationId}, ${A.titleId}, 'adjustment', 5,
                  '2025-05-04T10:00:00Z', ${dual.id})`,
      dual,
    );
    expect(outcome.code).toBe("42501");
  });

  it("admin i A + ägare i en annan organisation kan inte skapa en ägare i A", async () => {
    const adminA = await createUser();
    await addMember(A.orgId, adminA, "admin");
    await createOrg(adminA, "Adminens egen");
    const victim = await createUser();
    const outcome = await asAttacker(
      sql`insert into public.memberships (organization_id, user_id, role)
          values (${A.orgId}, ${victim.id}, 'owner')`,
      adminA,
    );
    expect(outcome.ok).toBe(false);
    expect(["42501", "BL006"]).toContain(outcome.code);
  });
});

describe("STOD EMOT: forbid_org_change gäller överallt och kan inte kopplas bort", () => {
  it("varje tabell med organization_id har triggern, aktiv, BEFORE UPDATE FOR EACH ROW", async () => {
    const result = await rows<{ table: string; enabled: string; tgtype: number }>(
      db(),
      sql`select c.relname as table, t.tgenabled as enabled, t.tgtype::int as tgtype
          from pg_trigger t
          join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
          join pg_proc p on p.oid = t.tgfoid
          join pg_namespace pn on pn.oid = p.pronamespace
          where n.nspname = 'public' and pn.nspname = 'private' and p.proname = 'forbid_org_change'
          order by 1`,
    );
    const byTable = new Map(result.map((r) => [r.table, r]));
    for (const table of scoped) {
      const trigger = byTable.get(table);
      expect(trigger, `${table} saknar forbid_org_change`).toBeDefined();
      expect(["O", "A"], `${table}: triggern är avstängd`).toContain(trigger!.enabled);
      // tgtype: 1 = ROW, 2 = BEFORE, 16 = UPDATE.
      expect(trigger!.tgtype & 1, table).toBe(1);
      expect(trigger!.tgtype & 2, table).toBe(2);
      expect(trigger!.tgtype & 16, table).toBe(16);
    }
  });

  it("insert ... on conflict do update kan inte flytta en rad till B (service_role)", async () => {
    const outcome = await asServiceRole((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.stores (id, organization_id, name)
              values (${A.storeId}, ${A.orgId}, 'x')
              on conflict (id) do update set organization_id = ${B.orgId}`,
        ),
      ),
    );
    expect(outcome.code).toBe("BL001");
  });

  it("organisationens id kan inte bytas (service_role)", async () => {
    const outcome = await asServiceRole((tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.organizations set id = ${randomUUID()} where id = ${A.orgId}`),
      ),
    );
    expect(outcome.code).toBe("BL001");
  });

  it.each(["authenticated", "service_role"])(
    "%s kan inte stänga av triggers eller sätta session_replication_role",
    async (role) => {
      const outcomes = await asPostgres(async (tx) => {
        await tx.execute(sql.raw(`set local role ${role}`));
        const replica = await attempt(tx, (sp) =>
          sp.execute(sql`set local session_replication_role = replica`),
        );
        const disable = await attempt(tx, (sp) =>
          sp.execute(sql`alter table public.orders disable trigger t00_forbid_org_change`),
        );
        return { replica, disable };
      });
      expect(outcomes.replica.code).toBe("42501");
      expect(outcomes.disable.code).toBe("42501");
    },
  );
});

describe("STOD EMOT: B:s rader går inte att nå med update/delete från A", () => {
  it.each(scoped)("%s: update och delete på B:s rad påverkar 0 rader", async (table) => {
    const row = await sampleRow(table, B.orgId);
    const touched = await asUser(A.owner, async (tx) => {
      const upd = await attempt(tx, (sp) =>
        sp.execute(
          sql`update ${rel(table)} set organization_id = organization_id where id = ${row!.id as string}`,
        ),
      );
      const del = await attempt(tx, (sp) =>
        sp.execute(sql`delete from ${rel(table)} where id = ${row!.id as string}`),
      );
      const count = (o: Outcome<unknown>) =>
        o.ok ? ((o.value as { count?: number }).count ?? 0) : 0;
      return count(upd) + count(del);
    });
    expect(touched).toBe(0);
  });
});
