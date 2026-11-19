/**
 * Kontrollen ska köras, och det ska höras när den inte gör det (robusthet 1B, punkt 2):
 *
 * - En kontroll som hänger sparas som "kunde inte köras" inom tidsgränsen och larmar
 *   (job:kontroll), i stället för att funktionen dödas utan att något har sparats.
 *   Nästa lyckade körning stänger larmet.
 * - Jobbet påbörjar ingen ny organisation när tiden är slut: den tas vid nästa tillfälle.
 * - Vakten: "Kontrollen har aldrig körts av sig själv" / "… inte körts sedan …" när ingen
 *   schemalagd körning finns på 26 timmar, med vad schemat fick till svar när det går att
 *   se; raden och larmet (watch:kontroll) försvinner när kontrollen har kört.
 * - Schemat: anropen från pg_cron loggas med svaret (private.cron_calls), de fem
 *   tick-funktionerna gör samma anrop som förut, och kontrollen anropas varje timme
 *   03:52–09:52 UTC.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_noStore: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

import type { CheckResult } from "@/analytics/self-check";
import { syncWatchAlerts, watchFor } from "@/server/monitoring/watch";
import { runScheduledSelfChecks } from "@/server/self-check/job";
import { runSelfCheck, withTimeout } from "@/server/self-check/run";

import { asPostgres, createOrg, createUser, db, one, rows, uniqueSuffix } from "./helpers";

class Rollback extends Error {}

const never = () => new Promise<CheckResult[]>(() => {});
const passing = async (): Promise<CheckResult[]> => [];
// Vakten räknar med en e-post som fungerar, så att bara kontrollens rad är i fokus.
const ENV = { MAIL_PROVIDER: "outbox" } as const;

let orgId: string;

async function runs(org: string) {
  return rows<{ trigger: string; status: string; error: string | null }>(
    db(),
    sql`select trigger, status, error from public.self_check_runs
        where organization_id = ${org}::uuid order by created_at`,
  );
}

async function openAlert(org: string, key: string) {
  return rows<{ title: string; message: string; severity: string }>(
    db(),
    sql`select title, message, severity::text from public.alerts
        where organization_id = ${org}::uuid and incident_key = ${key} and status = 'open'`,
  );
}

beforeAll(async () => {
  const owner = await createUser(`kontroll-vakt-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Kontroll vakt ${uniqueSuffix()}`);
});

describe("en kontroll som hänger", () => {
  it("withTimeout ger felet när tiden går ut och väntar inte på det som hänger", async () => {
    const started = Date.now();
    await expect(withTimeout(new Promise(() => {}), 30, "för sent")).rejects.toThrow("för sent");
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(withTimeout(Promise.resolve(7), 30, "för sent")).resolves.toBe(7);
  });

  it("sparas som fel inom tidsgränsen och larmar; nästa lyckade körning stänger larmet", async () => {
    const now = new Date("2026-11-19T04:52:00Z");
    const started = Date.now();
    const hung = await runSelfCheck(
      { db: db(), now, checks: never, runTimeoutMs: 1_000 },
      { organizationId: orgId, trigger: "schedule" },
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(hung.status).toBe("error");
    expect(hung.error).toBe("Kontrollen blev inte klar på 1 sekunder.");
    expect(await runs(orgId)).toEqual([
      { trigger: "schedule", status: "error", error: "Kontrollen blev inte klar på 1 sekunder." },
    ]);
    const [alert] = await openAlert(orgId, "job:kontroll");
    expect(alert?.title).toBe("Den dagliga kontrollen misslyckades");
    expect(alert?.message).toContain("Kontrollen blev inte klar på 1 sekunder.");
    expect(alert?.message).toContain("Kör kontrollen själv under Inställningar → Kontroll.");

    await runSelfCheck(
      { db: db(), now: new Date("2026-11-19T05:52:00Z"), checks: passing },
      { organizationId: orgId, trigger: "schedule" },
    );
    expect(await openAlert(orgId, "job:kontroll")).toEqual([]);
  });

  it("jobbet påbörjar ingen ny organisation när tiden är slut", async () => {
    const owner = await createUser(`kontroll-tid-${uniqueSuffix()}@test.binderlab.se`);
    const org = await createOrg(owner, `Kontroll tid ${uniqueSuffix()}`);
    const r = await runScheduledSelfChecks(db(), new Date("2026-11-19T04:52:00Z"), {
      only: [org],
      budgetMs: -1,
    });
    expect(r.organizations).toEqual([
      { organizationId: org, status: "skipped", reason: "no_time" },
    ]);
    expect(await runs(org)).toEqual([]);
  });
});

describe("vakten: kontrollen har inte körts", () => {
  it("säger till efter 26 timmar utan schemalagd körning, larmar, och tystnar när den har kört", async () => {
    const owner = await createUser(`kontroll-tyst-${uniqueSuffix()}@test.binderlab.se`);
    const org = await createOrg(owner, `Kontroll tyst ${uniqueSuffix()}`);
    // En ny organisation har inget att sakna än.
    expect((await watchFor(db(), org, new Date(), ENV)).map((l) => l.key)).not.toContain(
      "kontroll",
    );
    // "Kör kontrollen nu" räknas inte: det är schemat som vaktas.
    await runSelfCheck({ db: db(), checks: passing }, { organizationId: org, trigger: "manual" });

    const later = new Date(Date.now() + 3 * 86_400_000);
    const line = (await watchFor(db(), org, later, ENV)).find((l) => l.key === "kontroll");
    expect(line?.title).toBe("Kontrollen har aldrig körts av sig själv");
    expect(line?.href).toBe("/installningar/kontroll");

    await syncWatchAlerts(db(), org, later, ENV);
    await syncWatchAlerts(db(), org, later, ENV);
    const alerts = await openAlert(org, "watch:kontroll");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      title: "Kontrollen har aldrig körts av sig själv",
      severity: "critical",
    });

    // Schemat kör den: raden och larmet försvinner.
    await runSelfCheck(
      { db: db(), now: later, checks: passing },
      { organizationId: org, trigger: "schedule" },
    );
    expect((await watchFor(db(), org, later, ENV)).map((l) => l.key)).not.toContain("kontroll");
    await syncWatchAlerts(db(), org, later, ENV);
    expect(await openAlert(org, "watch:kontroll")).toEqual([]);

    // Två dygn senare utan ny körning: nu med tiden för den senaste.
    const stale = new Date(later.getTime() + 2 * 86_400_000);
    const again = (await watchFor(db(), org, stale, ENV)).find((l) => l.key === "kontroll");
    expect(again?.title.startsWith("Kontrollen har inte körts sedan ")).toBe(true);
  });

  it("säger vad schemat fick till svar när anropet är loggat", async () => {
    const owner = await createUser(`kontroll-svar-${uniqueSuffix()}@test.binderlab.se`);
    const org = await createOrg(owner, `Kontroll svar ${uniqueSuffix()}`);
    await asPostgres(async (tx) => {
      await tx.execute(sql`delete from private.cron_calls where job = 'kontroll'`);
      await tx.execute(
        sql`insert into private.cron_calls (job, request_id, called_at, answered_at, status_code, timed_out)
            values ('kontroll', 7, now() - interval '20 minutes', now() - interval '15 minutes', 500, false)`,
      );
      const later = new Date(Date.now() + 3 * 86_400_000);
      const line = (await watchFor(tx as never, org, later, ENV)).find((l) => l.key === "kontroll");
      expect(line?.detail).toContain("men fick fel 500 till svar.");
      throw new Rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  });
});

describe("pg_cron: anropen loggas med svaret (20261220110100)", () => {
  const migration = readFileSync(
    fileURLToPath(
      new URL(
        "../../supabase/migrations/20261220110100_cron_svar_och_fler_tillfallen.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("tick-funktionerna gör samma anrop som förut, loggar det och läser svaret", async () => {
    await asPostgres(async (tx) => {
      await tx.execute(
        sql`delete from vault.secrets where name in ('binderlab_app_url', 'binderlab_cron_secret')`,
      );
      await tx.execute(sql`drop schema if exists net cascade`);
      await tx.execute(sql`delete from private.cron_calls`);
      // Utan pg_net: ingenting, som förut.
      const none = await one<{ r: unknown }>(tx, sql`select private.kontroll_cron_tick() as r`);
      expect(none.r).toBeNull();

      // pg_net finns bara i Supabase: låtsasversioner med samma signaturer.
      await tx.execute(sql`create schema net`);
      await tx.execute(
        sql`create table net.calls (id bigserial, url text, headers jsonb, timeout int)`,
      );
      await tx.execute(sql`
        create table net._http_response (id bigint, status_code integer, content text,
                                         timed_out boolean, error_msg text)`);
      await tx.execute(sql`
        create function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}',
                                     timeout_milliseconds int default 5000)
        returns bigint language sql as $$
          insert into net.calls (url, headers, timeout) values (url, headers, timeout_milliseconds)
          returning id
        $$`);
      // Utan adress och hemlighet: ingenting.
      const noSecrets = await one<{ r: unknown }>(tx, sql`select private.awish_cron_tick() as r`);
      expect(noSecrets.r).toBeNull();
      await tx.execute(
        sql`select vault.create_secret('https://app.example.se', 'binderlab_app_url')`,
      );
      await tx.execute(
        sql`select vault.create_secret('en-lang-hemlighet-1234567890', 'binderlab_cron_secret')`,
      );

      for (const fn of ["awish", "ai", "bokforing", "kontroll", "vecka"]) {
        await tx.execute(sql.raw(`select private.${fn}_cron_tick()`));
      }
      const calls = await rows<{ url: string; headers: Record<string, string>; timeout: number }>(
        tx,
        sql`select url, headers, timeout from net.calls order by id`,
      );
      const auth = { Authorization: "Bearer en-lang-hemlighet-1234567890" };
      expect(calls).toEqual([
        { url: "https://app.example.se/api/cron/awish", headers: auth, timeout: 60000 },
        { url: "https://app.example.se/api/cron/ai", headers: auth, timeout: 300000 },
        { url: "https://app.example.se/api/cron/bokforing", headers: auth, timeout: 300000 },
        { url: "https://app.example.se/api/cron/kontroll", headers: auth, timeout: 300000 },
        { url: "https://app.example.se/api/cron/vecka", headers: auth, timeout: 300000 },
      ]);
      // Varje anrop är loggat med pg_net:s id, utan svar än.
      const logged = () =>
        rows<{
          job: string;
          status_code: number | null;
          timed_out: boolean | null;
          error: string | null;
          answered: boolean;
        }>(
          tx,
          sql`select job, status_code, timed_out, error, answered_at is not null as answered
              from private.cron_calls order by id`,
        );
      expect((await logged()).map((l) => [l.job, l.answered])).toEqual([
        ["awish", false],
        ["ai", false],
        ["bokforing", false],
        ["kontroll", false],
        ["vecka", false],
      ]);

      // Svaren kommer: 200 för synken, 500 för kontrollen, timeout för bokföringen.
      await tx.execute(sql`
        insert into net._http_response (id, status_code, content, timed_out, error_msg)
        select c.id, case when c.url like '%/awish' then 200 when c.url like '%/kontroll' then 500 end,
               case when c.url like '%/kontroll' then '{"error":"Databasen svarar inte."}' else '{"ok":true}' end,
               c.url like '%/bokforing',
               case when c.url like '%/bokforing' then 'Timeout was reached' end
        from net.calls c where c.url not like '%/ai' and c.url not like '%/vecka'`);
      // Nästa tick läser dem (Awish-synken går var femte minut).
      await tx.execute(sql`select private.awish_cron_tick()`);
      const after = await logged();
      expect(after.find((l) => l.job === "awish")).toMatchObject({
        status_code: 200,
        timed_out: false,
        error: null,
        answered: true,
      });
      expect(after.find((l) => l.job === "kontroll")).toMatchObject({
        status_code: 500,
        error: '{"error":"Databasen svarar inte."}',
        answered: true,
      });
      expect(after.find((l) => l.job === "bokforing")).toMatchObject({
        status_code: null,
        timed_out: true,
        error: "Timeout was reached",
        answered: true,
      });
      // De som inte har svarat står kvar som obesvarade.
      expect(after.find((l) => l.job === "ai")).toMatchObject({ answered: false });

      // Ett fel i loggningen stoppar aldrig anropet.
      await tx.execute(sql`alter table private.cron_calls rename column job to jobb`);
      const still = await one<{ r: string | null }>(
        tx,
        sql`select private.awish_cron_tick()::text as r`,
      );
      expect(still.r).not.toBeNull();
      throw new Rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  });

  it("klientroller når varken loggen eller anropet", async () => {
    const owner = await createUser(`kontroll-roll-${uniqueSuffix()}@test.binderlab.se`);
    await createOrg(owner, `Kontroll roll ${uniqueSuffix()}`);
    const { asUser, attempt } = await import("./helpers");
    const read = await asUser(owner, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`select * from private.cron_calls`)),
    );
    expect(read.ok).toBe(false);
    const call = await asUser(owner, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`select private.cron_call('x', '/api/cron/awish', 1000)`)),
    );
    expect(call.ok).toBe(false);
  });

  it("kontrollen schemaläggs varje timme 03:52–09:52 och bokföringen 03:37 och 05:37", async () => {
    const block = /do \$\$[\s\S]*?\n\$\$;/.exec(migration)?.[0];
    expect(block).toBeTruthy();
    await asPostgres(async (tx) => {
      await tx.execute(sql`drop schema if exists cron cascade`);
      await tx.execute(sql`drop schema if exists net cascade`);
      // Lokalt och i CI: inget pg_cron, inget fel.
      await tx.execute(sql.raw(block!));

      await tx.execute(sql`create schema net`);
      await tx.execute(sql`create schema cron`);
      await tx.execute(sql`
        create table cron.job (jobid bigserial primary key, jobname text unique,
                               schedule text not null, command text not null)`);
      await tx.execute(sql`
        create function cron.schedule(job_name text, schedule text, command text)
        returns bigint language plpgsql as $$
        declare v bigint;
        begin
          insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
          on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
          returning jobid into v;
          return v;
        end $$`);
      await tx.execute(sql`
        create function cron.unschedule(job_name text) returns boolean language plpgsql as $$
        begin
          delete from cron.job where jobname = job_name;
          if not found then raise exception 'jobbet % finns inte', job_name; end if;
          return true;
        end $$`);
      await tx.execute(sql`
        insert into cron.job (jobname, schedule, command) values
          ('binderlab-kontroll', '37 3,4 * * *', 'select private.kontroll_cron_tick()'),
          ('binderlab-bokforing', '37 3 * * *', 'select private.bokforing_cron_tick()'),
          ('binderlab-awish-sync', '*/5 * * * *', 'select private.awish_cron_tick()')`);
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
          jobname: "binderlab-bokforing",
          schedule: "37 3,5 * * *",
          command: "select private.bokforing_cron_tick()",
        },
        {
          jobname: "binderlab-kontroll",
          schedule: "52 3-9 * * *",
          command: "select private.kontroll_cron_tick()",
        },
      ];
      await tx.execute(sql.raw(block!));
      expect(await jobs()).toEqual(expected);
      // Idempotent: en andra körning ger samma schema.
      await tx.execute(sql.raw(block!));
      expect(await jobs()).toEqual(expected);
      throw new Rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  });
});
