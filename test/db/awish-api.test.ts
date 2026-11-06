/**
 * Awish officiella gRPC-API (docs/awish-api.md) mot testdatabasen och en låtsas-Awish
 * (riktig gRPC-server på 127.0.0.1, src/server/awish/testing/fake-server.ts):
 *
 * - Vault: bara ägare och admin kan spara AppId/AppSecret/AppKey (påfyllare, läsare,
 *   butik och andra organisationer nekas), hemligheten hamnar aldrig i data_sources och
 *   returneras aldrig, klientroller kan inte läsa Vault eller private.awish_read_credentials.
 * - Synken: hela historiken över flera körningar, idempotent, sena betalningar inom
 *   dygnet, återbetald efter import loggas en gång, källans tidszon, källautomater,
 *   samma försäljning i en uppladdad CSV-källa importeras inte igen, last_synced_at.
 * - Testa anslutningen och pg_cron-funktionen (private.awish_cron_tick).
 * - Migreringen som schemalägger om jobbet till var femte minut (20261112000000).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { listOrganizationsFor } from "../../src/server/access";
import { createAwishClient } from "../../src/server/awish/grpc-client";
import {
  loadAwishPanelFor,
  saveAwishCredentialsFor,
  syncAwishNowFor,
  testAwishConnectionFor,
} from "../../src/server/awish/manage";
import { syncAllAwishSources, syncAwishSource } from "../../src/server/awish/sync";
import {
  fakeOrder,
  startFakeAwish,
  type FakeAwish,
} from "../../src/server/awish/testing/fake-server";
import type { Viewer } from "../../src/server/data/core/loaders";

import {
  asPostgres,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fake: FakeAwish;
const connect = (creds: { appId: string; appSecret: string; appKey: string }) =>
  createAwishClient(creds, { address: fake.address, tls: false, sleep: async () => {} });

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [{ id: "2", name: "BL-001 Centrum", machine_no: "163271xx" }],
  });
});
afterAll(async () => {
  await fake.stop();
});

describe("Vault: inloggningsuppgifterna", () => {
  let owner: TestUser;
  let orgId: string;
  let sourceId: string;

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: "app-1234",
      appSecret: "secret-ABCD",
      appKey: "key-WXYZ",
    }));
  });

  it("ägaren sparar; data_sources har bara referens och fyra sista tecknen", async () => {
    const ds = await one<{ secret_ref: string; config: unknown; provider: string; name: string }>(
      db(),
      sql`select secret_ref, config, provider::text as provider, name from public.data_sources
          where id = ${sourceId}::uuid`,
    );
    expect(ds.provider).toBe("awish_grpc");
    expect(ds.name).toBe("Awish API");
    expect(ds.secret_ref).toBe(`${orgId}/awish_grpc:${sourceId}`);
    const text = JSON.stringify(ds.config);
    expect(text).not.toContain("secret-ABCD");
    expect(text).not.toContain("key-WXYZ");
    expect(text).not.toContain("app-1234");
    expect(ds.config).toMatchObject({
      awishGrpc: {
        // Kortare än 12 tecken: inga tecken av hemligheten i config (Läsare kan läsa den).
        credentials: { appIdLast4: "1234", appSecretLast4: "", appKeyLast4: "" },
      },
    });
    const vault = await one<{ secret: string }>(
      db(),
      sql`select decrypted_secret as secret from vault.decrypted_secrets where name = ${ds.secret_ref}`,
    );
    expect(JSON.parse(vault.secret)).toEqual({
      appId: "app-1234",
      appSecret: "secret-ABCD",
      appKey: "key-WXYZ",
    });
    // Granskningsloggen har inga hemligheter heller.
    const audit = await rows<{ after: unknown }>(
      db(),
      sql`select after from public.audit_log where row_id = ${sourceId}::uuid`,
    );
    expect(JSON.stringify(audit)).not.toContain("secret-ABCD");
  });

  it("RPC:n returnerar aldrig hemligheten; tomma fält behåller det sparade", async () => {
    const r = await asUser(owner, (tx) =>
      one<{ r: Record<string, unknown> }>(
        tx,
        sql`select public.awish_save_credentials(${orgId}::uuid, ${sourceId}::uuid, '', 'nytt-secret-9876', '') as r`,
      ),
    );
    expect(JSON.stringify(r.r)).not.toContain("nytt-secret");
    expect(r.r).toMatchObject({ appSecretLast4: "9876", appKeyLast4: "" });
    const v = await one<{ s: string }>(
      db(),
      sql`select decrypted_secret as s from vault.decrypted_secrets where name = ${`${orgId}/awish_grpc:${sourceId}`}`,
    );
    expect(JSON.parse(v.s)).toEqual({
      appId: "app-1234",
      appSecret: "nytt-secret-9876",
      appKey: "key-WXYZ",
    });
    const count = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from vault.secrets where name like ${`${orgId}/%`}`,
    );
    expect(count.n).toBe(1);
  });

  it("admin får spara; påfyllare, läsare, butik och andra organisationer nekas", async () => {
    const admin = await createMember(orgId, "admin");
    const ok = await asUser(admin, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.awish_save_credentials(${orgId}::uuid, ${sourceId}::uuid, null, null, 'admin-key-1111')`,
        ),
      ),
    );
    expect(ok.ok).toBe(true);

    const refiller = await createMember(orgId, "refiller");
    const viewer = await createMember(orgId, "viewer");
    const store = await createUser();
    // Butiksanvändaren (rollen store) hör till en butik i organisationen.
    await asPostgres(async (tx) => {
      const [shop] = await rows<{ id: string }>(
        tx,
        sql`insert into public.stores (organization_id, name) values (${orgId}::uuid, 'Testbutik')
            returning id`,
      );
      await tx.execute(
        sql`insert into public.memberships (organization_id, user_id, role, store_id)
            values (${orgId}::uuid, ${store.id}::uuid, 'store', ${shop!.id}::uuid)`,
      );
    });
    const outsider = await createUser();
    const otherOrg = await createOrg(outsider, "Annan");
    for (const u of [refiller, viewer, store, outsider]) {
      const denied = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`select public.awish_save_credentials(${orgId}::uuid, ${sourceId}::uuid, 'x', 'y', 'z')`,
          ),
        ),
      );
      expect(denied.ok, u.email).toBe(false);
      if (!denied.ok) expect(denied.code).toBe("42501");
    }
    // Ägaren i en annan organisation kan inte peka sin egen organisation på A:s källa.
    const cross = await asUser(outsider, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.awish_save_credentials(${otherOrg}::uuid, ${sourceId}::uuid, 'x', 'y', 'z')`,
        ),
      ),
    );
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.code).toBe("P0002");
  });

  it("klientroller kan inte läsa Vault eller anropa läsfunktionen", async () => {
    for (const q of [
      sql`select * from vault.decrypted_secrets`,
      sql`select * from vault.secrets`,
      sql`select private.awish_read_credentials(${sourceId}::uuid)`,
      sql`select private.awish_cron_tick()`,
    ]) {
      const r = await asUser(owner, (tx) => attempt(tx, (sp) => sp.execute(q)));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("42501");
    }
  });

  it("påfyllaren når inte server actions-funktionerna", async () => {
    const refiller = await createMember(orgId, "refiller");
    const v = await viewerFor(refiller, orgId);
    await expect(loadAwishPanelFor(v)).rejects.toThrow();
    await expect(testAwishConnectionFor(v, { connect })).rejects.toThrow();
    await expect(syncAwishNowFor(v, { connect })).rejects.toThrow();
  });
});

describe("synken mot låtsas-Awish", () => {
  let owner: TestUser;
  let orgId: string;
  let sourceId: string;

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    fake.state.orders = [];
    for (let id = 1; id <= 45; id += 1) {
      fake.state.orders.push(
        fakeOrder(1000 + id, {
          // En order per timme bakåt från 2 nov. 23:00 Shanghai-tid.
          payTime: shanghai(Date.UTC(2026, 10, 2, 15, 0, 0) - (45 - id) * 3_600_000),
          title: id % 2 === 0 ? "30th Celebration" : "Ascended Heroes",
        }),
      );
    }
    ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    }));
  });

  const NOW = new Date("2026-11-02T15:30:00Z");
  const run = (maxPages = 50) =>
    syncAwishSource({ db: db(), connect, now: () => NOW, maxPages }, { dataSourceId: sourceId });
  const orderCount = async () =>
    (
      await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.orders where data_source_id = ${sourceId}::uuid`,
      )
    ).n;

  it("testa anslutningen visar handlare, automater och senaste order utan att importera", async () => {
    const t = await testAwishConnectionFor(await viewerFor(owner, orgId), { connect });
    expect(t).toMatchObject({
      merchantTitle: "Testhandlare",
      machines: 1,
      totalOrders: 45,
      newestOrder: { id: "1045" },
    });
    expect(await orderCount()).toBe(0);
  });

  it("första synken läser historiken över flera körningar och sedan inget mer", async () => {
    const first = await run(2);
    expect(first.ok).toBe(true);
    expect(first.historyDone).toBe(false);
    for (let i = 0; i < 5; i += 1) {
      const r = await run(2);
      expect(r.ok, r.message ?? "").toBe(true);
      if (r.historyDone) break;
    }
    expect(await orderCount()).toBe(45);
    const again = await run();
    expect(again.ok).toBe(true);
    expect(again.summary).toBeNull();
    expect(await orderCount()).toBe(45);

    const imports = await rows<{ trigger: string; status: string; parser_version: string }>(
      db(),
      sql`select trigger::text as trigger, status::text as status, parser_version
          from public.imports where data_source_id = ${sourceId}::uuid`,
    );
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((i) => i.trigger === "schedule" && i.status === "succeeded")).toBe(true);
    expect(imports[0]?.parser_version).toMatch(/^awish_grpc\/1\+pipeline\//);
  });

  it("tid i källans tidszon, automat och betalmetod", async () => {
    const o = await one<{
      ordered_at: Date;
      business_date: string;
      payment_method: string;
      amount_ore: string;
      external_id: string;
    }>(
      db(),
      sql`select ordered_at, business_date::text as business_date, payment_method,
                 amount_ore::text as amount_ore, external_id
          from public.orders where data_source_id = ${sourceId}::uuid and external_id = '1045'`,
    );
    expect(new Date(o.ordered_at).toISOString()).toBe("2026-11-02T15:00:00.000Z");
    expect(o.business_date).toBe("2026-11-02");
    expect(o.payment_method).toBe("Card");
    expect(o.amount_ore).toBe("17000");
    const machines = await rows<{ external_id: string; external_name: string; device: string }>(
      db(),
      sql`select external_id, external_name, external_device_no as device
          from public.source_machines where data_source_id = ${sourceId}::uuid`,
    );
    expect(machines).toEqual([
      { external_id: "2", external_name: "BL-001 Centrum", device: "163271xx" },
    ]);
  });

  it("en sen betalning inom dygnet hämtas; återbetald efter import loggas en gång", async () => {
    fake.state.orders.push(
      fakeOrder(1046, { status: "PAY_NOTPAY", payTime: null, date: "2026-11-02" }),
    );
    const unpaid = await run();
    expect(unpaid.ok).toBe(true);
    expect(await orderCount()).toBe(45);

    const late = fake.state.orders.find((o) => o.id === "1046")!;
    late.status = "PAY_SUCCESS";
    late.payTime = "2026-11-02 23:20:00";
    fake.state.orders.push(fakeOrder(1047, { payTime: "2026-11-02 23:25:00" }));
    const paid = await run();
    expect(paid.summary?.new).toBe(2);
    expect(await orderCount()).toBe(47);

    fake.state.orders.find((o) => o.id === "1047")!.status = "PAY_REFUNDED";
    const refunded = await run();
    expect(refunded.summary?.conflict).toBe(1);
    const again = await run();
    expect(again.summary).toBeNull();
    // Ordern ändras aldrig.
    expect(await orderCount()).toBe(47);
  });

  it("panelen visar status utan hemligheter", async () => {
    const panel = await loadAwishPanelFor(await viewerFor(owner, orgId));
    expect(panel.source).toMatchObject({
      orders: 47,
      historyDone: true,
      credentials: { appSecretLast4: fake.state.appSecret.slice(-4) },
      lastRun: { ok: true },
    });
    expect(panel.source?.lastSyncedAt).not.toBeNull();
    expect(JSON.stringify(panel)).not.toContain(fake.state.appSecret);
  });

  it("fel AppSecret: synken misslyckas med svenskt fel och last_synced_at ändras inte", async () => {
    const before = await one<{ t: Date }>(
      db(),
      sql`select last_synced_at as t from public.data_sources where id = ${sourceId}::uuid`,
    );
    await asUser(owner, (tx) =>
      tx.execute(
        sql`select public.awish_save_credentials(${orgId}::uuid, ${sourceId}::uuid, null, 'fel', null)`,
      ),
    );
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/AppSecret eller AppKey/);
    const after = await one<{ t: Date; cursor: string }>(
      db(),
      sql`select last_synced_at as t, cursor from public.data_sources where id = ${sourceId}::uuid`,
    );
    expect(after.t).toEqual(before.t);
    expect(after.cursor).not.toContain("fel");
    await asUser(owner, (tx) =>
      tx.execute(
        sql`select public.awish_save_credentials(${orgId}::uuid, ${sourceId}::uuid, null, ${fake.state.appSecret}, null)`,
      ),
    );
  });

  it("cron: alla aktiva källor; en pausad källa hoppas över", async () => {
    const all = await syncAllAwishSources({ db: db(), connect, now: () => NOW });
    const mine = all.sources.find((s) => s.dataSourceId === sourceId);
    expect(mine?.ok).toBe(true);
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.data_sources set status = 'paused' where id = ${sourceId}::uuid`,
      ),
    );
    const paused = await run();
    expect(paused.skipped).toBe("paused");
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.data_sources set status = 'active' where id = ${sourceId}::uuid`,
      ),
    );
  });
});

describe("samma försäljning i en uppladdad CSV-källa", () => {
  it("importeras inte en gång till", async () => {
    const owner = await createUser();
    const orgId = await createOrg(owner);
    // En CSV-källa med en order som betalades 2026-11-02 00:17:00 Shanghai-tid (42780).
    await asPostgres(async (tx) => {
      const [csv] = await rows<{ id: string }>(
        tx,
        sql`insert into public.data_sources (organization_id, provider, name)
            values (${orgId}::uuid, 'awish_csv', 'Awish CSV') returning id`,
      );
      await tx.execute(
        sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title,
              ordered_at, business_date, amount_ore, source_hash)
            values (${orgId}::uuid, ${csv!.id}::uuid, '42780', '30th Celebration',
              '2026-11-01T16:17:00Z', '2026-11-01', 17000, 'x')`,
      );
    });
    fake.state.orders = [
      fakeOrder(880459, { payTime: "2026-11-02 00:17:00" }),
      fakeOrder(880460, { payTime: "2026-11-02 00:20:00" }),
    ];
    const { dataSourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    });
    const r = await syncAwishSource(
      { db: db(), connect, now: () => new Date("2026-11-02T00:00:00Z") },
      { dataSourceId },
    );
    expect(r.ok).toBe(true);
    expect(r.otherSourceDuplicates).toBe(1);
    expect(r.summary?.new).toBe(1);
    const ids = await rows<{ external_id: string }>(
      db(),
      sql`select external_id from public.orders where data_source_id = ${dataSourceId}::uuid`,
    );
    expect(ids.map((x) => x.external_id)).toEqual(["880460"]);
  });
});

describe("pg_cron: private.awish_cron_tick", () => {
  it("gör ingenting utan pg_net eller utan adress och hemlighet; annars GET med Bearer", async () => {
    await asPostgres(async (tx) => {
      await tx.execute(
        sql`delete from vault.secrets where name in ('binderlab_app_url', 'binderlab_cron_secret')`,
      );
      await tx.execute(sql`drop schema if exists net cascade`);
      const none = await one<{ r: unknown }>(tx, sql`select private.awish_cron_tick() as r`);
      expect(none.r).toBeNull();

      // pg_net finns bara i Supabase: en låtsasfunktion med samma signatur.
      await tx.execute(sql`create schema net`);
      await tx.execute(sql`create table net.calls (url text, headers jsonb, timeout int)`);
      await tx.execute(sql`
        create function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}',
                                     timeout_milliseconds int default 5000)
        returns bigint language sql as $$
          insert into net.calls values (url, headers, timeout_milliseconds) returning 42::bigint
        $$`);
      const noSecrets = await one<{ r: unknown }>(tx, sql`select private.awish_cron_tick() as r`);
      expect(noSecrets.r).toBeNull();

      await tx.execute(
        sql`select vault.create_secret('https://app.example.se', 'binderlab_app_url')`,
      );
      await tx.execute(sql`select vault.create_secret('kort', 'binderlab_cron_secret')`);
      const short = await one<{ r: unknown }>(tx, sql`select private.awish_cron_tick() as r`);
      expect(short.r).toBeNull();

      await tx.execute(
        sql`update vault.secrets set secret = 'en-lang-hemlighet-1234567890' where name = 'binderlab_cron_secret'`,
      );
      const ok = await one<{ r: string }>(tx, sql`select private.awish_cron_tick()::text as r`);
      expect(ok.r).toBe("42");
      const calls = await rows<{ url: string; headers: Record<string, string>; timeout: number }>(
        tx,
        sql`select url, headers, timeout from net.calls`,
      );
      expect(calls).toEqual([
        {
          url: "https://app.example.se/api/cron/awish",
          headers: { Authorization: "Bearer en-lang-hemlighet-1234567890" },
          timeout: 60000,
        },
      ]);
      // Allt ovan rullas tillbaka (låtsas-pg_net och hemligheterna).
      throw new Rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  });
});

describe("pg_cron: binderlab-awish-sync var femte minut (20261112000000)", () => {
  const migration = readFileSync(
    fileURLToPath(
      new URL(
        "../../supabase/migrations/20261112000000_awish_synk_var_femte_minut.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("utan pg_cron gör migreringen ingenting; med pg_cron schemaläggs jobbet om, idempotent", async () => {
    await asPostgres(async (tx) => {
      await tx.execute(sql`drop schema if exists cron cascade`);
      await tx.execute(sql`drop schema if exists net cascade`);
      // Lokalt och i CI: inget pg_cron, inget fel.
      await tx.execute(sql.raw(migration));

      // pg_cron och pg_net finns bara i Supabase: låtsasversioner med samma signaturer.
      await tx.execute(sql`create schema net`);
      await tx.execute(sql`create schema cron`);
      await tx.execute(sql`
        create table cron.job (jobid bigserial primary key, jobname text unique,
                               schedule text not null, command text not null)`);
      await tx.execute(sql`create table cron.calls (n serial, fn text, jobname text)`);
      await tx.execute(sql`
        create function cron.schedule(job_name text, schedule text, command text)
        returns bigint language plpgsql as $$
        declare v bigint;
        begin
          insert into cron.calls (fn, jobname) values ('schedule', job_name);
          insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
          on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
          returning jobid into v;
          return v;
        end $$`);
      await tx.execute(sql`
        create function cron.unschedule(job_name text) returns boolean language plpgsql as $$
        begin
          insert into cron.calls (fn, jobname) values ('unschedule', job_name);
          delete from cron.job where jobname = job_name;
          if not found then raise exception 'jobbet % finns inte', job_name; end if;
          return true;
        end $$`);
      await tx.execute(sql`
        insert into cron.job (jobname, schedule, command) values
          ('binderlab-awish-sync', '*/10 * * * *', 'select private.awish_cron_tick()'),
          ('binderlab-cron-cleanup', '23 3 * * *', 'delete from cron.job_run_details')`);

      const jobs = () =>
        rows<{ jobname: string; schedule: string; command: string }>(
          tx,
          sql`select jobname, schedule, command from cron.job order by jobname`,
        );
      const expected = [
        {
          jobname: "binderlab-awish-sync",
          schedule: "*/5 * * * *",
          command: "select private.awish_cron_tick()",
        },
        {
          jobname: "binderlab-cron-cleanup",
          schedule: "23 3 * * *",
          command: "delete from cron.job_run_details",
        },
      ];

      // Det befintliga jobbet (var tionde minut) skrivs om; rensningsjobbet rörs inte.
      await tx.execute(sql.raw(migration));
      expect(await jobs()).toEqual(expected);
      // En gång till: samma resultat.
      await tx.execute(sql.raw(migration));
      expect(await jobs()).toEqual(expected);
      // Jobbet saknas helt: det skapas.
      await tx.execute(sql`delete from cron.job where jobname = 'binderlab-awish-sync'`);
      await tx.execute(sql.raw(migration));
      expect(await jobs()).toEqual(expected);
      const calls = await rows<{ fn: string; jobname: string }>(
        tx,
        sql`select fn, jobname from cron.calls order by n`,
      );
      expect(calls).toEqual([
        { fn: "unschedule", jobname: "binderlab-awish-sync" },
        { fn: "schedule", jobname: "binderlab-awish-sync" },
        { fn: "unschedule", jobname: "binderlab-awish-sync" },
        { fn: "schedule", jobname: "binderlab-awish-sync" },
        { fn: "schedule", jobname: "binderlab-awish-sync" },
      ]);

      // Utan pg_net (tick-funktionen gör då ingenting) lämnas jobbet som det är.
      await tx.execute(sql`update cron.job set schedule = '*/10 * * * *'`);
      await tx.execute(sql`drop schema net cascade`);
      await tx.execute(sql.raw(migration));
      expect((await jobs())[0]?.schedule).toBe("*/10 * * * *");
      throw new Rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  });
});

class Rollback extends Error {}

/** UTC-millisekunder → "YYYY-MM-DD HH:mm:ss" i Shanghai-tid (UTC+8, ingen sommartid). */
function shanghai(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

describe("granskningen: tidszon, belopp utan decimaler, läget vid nytt AppId", () => {
  it("en ny API-källa får samma tidszon som organisationens Awish CSV-källa", async () => {
    const owner = await createUser();
    const orgId = await createOrg(owner);
    await asPostgres((tx) =>
      tx.execute(
        sql`insert into public.data_sources (organization_id, provider, name, source_timezone)
            values (${orgId}::uuid, 'awish_csv', 'Awish CSV', 'Europe/Stockholm')`,
      ),
    );
    const { dataSourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    });
    const ds = await one<{ tz: string }>(
      db(),
      sql`select source_timezone as tz from public.data_sources where id = ${dataSourceId}::uuid`,
    );
    expect(ds.tz).toBe("Europe/Stockholm");
  });

  it("ett betalt belopp utan decimaler stoppar körningen tills formatet är känt", async () => {
    const owner = await createUser();
    const orgId = await createOrg(owner);
    const { dataSourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    });
    const now = () => new Date("2026-11-02T00:00:00Z");
    fake.state.orders = [fakeOrder(5001, { payTime: "2026-11-02 07:00:00", amount: "400" })];
    const stopped = await syncAwishSource({ db: db(), connect, now }, { dataSourceId });
    expect(stopped.ok).toBe(false);
    expect(stopped.message).toMatch(/utan decimaler/);
    const count = async () =>
      (
        await one<{ n: number }>(
          db(),
          sql`select count(*)::int as n from public.orders where data_source_id = ${dataSourceId}::uuid`,
        )
      ).n;
    expect(await count()).toBe(0);
    // När ett belopp med decimalpunkt har setts tolkas heltal som kronor.
    fake.state.orders.push(fakeOrder(5002, { payTime: "2026-11-02 07:05:00", amount: "4.00" }));
    const ok = await syncAwishSource({ db: db(), connect, now }, { dataSourceId });
    expect(ok.ok).toBe(true);
    expect(await count()).toBe(2);
    const amounts = await rows<{ external_id: string; amount_ore: string }>(
      db(),
      sql`select external_id, amount_ore::text from public.orders
          where data_source_id = ${dataSourceId}::uuid order by external_id`,
    );
    expect(amounts).toEqual([
      { external_id: "5001", amount_ore: "40000" },
      { external_id: "5002", amount_ore: "400" },
    ]);
  });

  it("obetalda order loggas inte i varje import", async () => {
    const owner = await createUser();
    const orgId = await createOrg(owner);
    const { dataSourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    });
    const now = () => new Date("2026-11-02T00:00:00Z");
    fake.state.orders = [
      fakeOrder(6001, { payTime: "2026-11-02 07:00:00" }),
      fakeOrder(6002, { status: "PAY_NOTPAY", payTime: null }),
    ];
    const first = await syncAwishSource({ db: db(), connect, now }, { dataSourceId });
    fake.state.orders.push(fakeOrder(6003, { payTime: "2026-11-02 07:10:00" }));
    const second = await syncAwishSource({ db: db(), connect, now }, { dataSourceId });
    expect(first.summary?.new).toBe(1);
    expect(second.summary?.new).toBe(1);
    const logged = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.import_rows ir
          join public.imports i on i.organization_id = ir.organization_id and i.id = ir.import_id
          where i.data_source_id = ${dataSourceId}::uuid and ir.raw ->> 'id' = '6002'`,
    );
    expect(logged[0]?.n).toBe(0);
  });

  it("sparas ett nytt AppId under en körning skrivs det gamla kontots läge inte tillbaka", async () => {
    const owner = await createUser();
    const orgId = await createOrg(owner);
    const viewer = await viewerFor(owner, orgId);
    const { dataSourceId } = await saveAwishCredentialsFor(viewer, {
      appId: fake.state.appId,
      appSecret: fake.state.appSecret,
      appKey: fake.state.appKey,
    });
    fake.state.orders = [fakeOrder(7001, { payTime: "2026-11-02 07:00:00" })];
    let saved = false;
    const racing = (creds: { appId: string; appSecret: string; appKey: string }) => {
      const api = connect(creds);
      return {
        ...api,
        async orders(page: Parameters<typeof api.orders>[0]) {
          const res = await api.orders(page);
          if (!saved) {
            saved = true;
            await saveAwishCredentialsFor(viewer, {
              appId: "annat-konto",
              appSecret: "",
              appKey: "",
            });
          }
          return res;
        },
      };
    };
    const r = await syncAwishSource(
      { db: db(), connect: racing, now: () => new Date("2026-11-02T00:00:00Z") },
      { dataSourceId },
    );
    expect(r.ok).toBe(true);
    const state = await one<{ cursor: string }>(
      db(),
      sql`select cursor from public.data_sources where id = ${dataSourceId}::uuid`,
    );
    const parsed = JSON.parse(state.cursor) as {
      paging: { historyDone: boolean } | undefined;
      leaseUntil: unknown;
      lastRun: { ok: boolean } | null;
    };
    expect(parsed.paging?.historyDone ?? false).toBe(false);
    expect(parsed.leaseUntil).toBeNull();
    expect(parsed.lastRun?.ok).toBe(true);
  });
});
