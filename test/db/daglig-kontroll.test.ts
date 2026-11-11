/**
 * Daglig kontroll (src/server/self-check) mot en seedad databas: fyra automater, fyra
 * butiker med alla sorters avtal (vinstdelning, bara hyra, provision + hyra, inget avtal),
 * två automater kopplade till Awish med push påslagen, en påfyllning som nått Awish och
 * obetalda avräkningar för oktober.
 *
 *   1. Allt stämmer: alla sju kontroller går igenom, inget larm, under 20 s.
 *   2. Varje kontroll bryts med avsikt (en sida räknar fel, Awish och appen skiljer, en
 *      påfyllning utan push, synken har stannat, en avräkning som inte går att räkna,
 *      order utan titel och negativt saldo): kontrollen blir röd, ETT larm skapas (även
 *      efter två körningar), ägaren får ett utskick, läsaren och påfyllaren inget.
 *   3. Rättat: kontrollen går igenom igen och larmet stängs.
 *   4. Kontrollen skriver aldrig affärsdata; en demo larmar i appen men skickar inget.
 *
 * Klockan är den riktiga (databasens now() stämplar händelserna), med körningen tio
 * minuter fram så att en ny påfyllning hunnit bli bedömbar (PUSH_GRACE_MINUTES).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type ButikerData = typeof ButikerDataModule;

// Ett fel i en sida, med avsikt: Butikers rader visar 1 kr mer än de borde.
// `butikerOnce`: bara nästa anrop räknar fel (som en order som synkas mitt i körningen).
const fault = vi.hoisted(() => ({ butiker: false, butikerOnce: false }));

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
vi.mock("@/app/(app)/butiker/_lib/data", async (importOriginal) => {
  const m = await importOriginal<ButikerData>();
  return {
    ...m,
    loadStoreListWith: async (...args: Parameters<typeof m.loadStoreListWith>) => {
      const r = await m.loadStoreListWith(...args);
      const once = fault.butikerOnce;
      fault.butikerOnce = false;
      if (!fault.butiker && !once) return r;
      return {
        ...r,
        rows: r.rows.map((x, i) => (i === 0 ? { ...x, profitOre: x.profitOre + 100 } : x)),
      };
    },
  };
});

import type { CheckResult, SelfCheckId } from "@/analytics/self-check";
import type * as ButikerDataModule from "@/app/(app)/butiker/_lib/data";
import { LocalFileStore } from "@/import/file-store";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { runScheduledSelfChecks } from "@/server/self-check/job";
import { runSelfCheck, type SelfCheckRunResult } from "@/server/self-check/run";
import {
  latestSelfCheckFor,
  loadSelfCheckFor,
  runSelfCheckNowFor,
  SelfCheckBusyError,
} from "@/server/self-check/service";
import { createMonthlySettlements } from "@/server/settlements/service";
import { runSeed } from "@/seed/run-seed";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

let orgId: string;
let owner: TestUser;
let viewer: TestUser;
let refiller: TestUser;
let ownerViewer: Viewer;
let sourceId: string;
const machineIds = new Map<string, string>();
const locationIds = new Map<string, string>();
const storeIds = new Map<string, string>();

/** Körningens tid: tio minuter fram (påfyllningar inom PUSH_GRACE_MINUTES bedöms inte). */
const at = () => new Date(Date.now() + 10 * 60_000);

async function run(): Promise<SelfCheckRunResult> {
  const r = await runSelfCheck(
    { db: db(), now: at() },
    { organizationId: orgId, trigger: "schedule" },
  );
  if (process.env.DEBUG_KONTROLL) {
    console.log(
      JSON.stringify(statuses(r)),
      JSON.stringify(
        r.checks.filter((c) => c.status !== "pass").map((c) => c.findings.slice(0, 2)),
      ),
    );
  }
  return r;
}

function check(r: SelfCheckRunResult, id: SelfCheckId): CheckResult {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`Saknar kontrollen ${id}`);
  return c;
}

function statuses(r: SelfCheckRunResult): Record<string, string> {
  return Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
}

async function openAlerts(): Promise<{ key: string; occurrences: number; id: string }[]> {
  return rows(
    db(),
    sql`select incident_key as key, occurrences, id from public.alerts
        where organization_id = ${orgId}::uuid and kind = 'self_check' and status = 'open'
        order by incident_key`,
  );
}

async function deliveriesFor(alertId: string): Promise<string[]> {
  const list = await rows<{ user_id: string }>(
    db(),
    sql`select user_id::text from public.alert_deliveries
        where organization_id = ${orgId}::uuid and ${alertId}::uuid = any(alert_ids)`,
  );
  return list.map((r) => r.user_id);
}

/** Awish facken = appens saldo nu i de kopplade automaterna (en läsning just nu). */
async function awishReadNow(): Promise<void> {
  for (const code of ["BL-001", "BL-002"]) {
    const loc = locationIds.get(code)!;
    await db().execute(sql`
      update public.stock_locations l
         set awish_synced_at = now(),
             awish_fill = coalesce((
               select jsonb_agg(jsonb_build_object('title_id', sl.title_id, 'units', sl.quantity,
                                                   'capacity', 20, 'channels', 1, 'empty', 0))
               from public.stock_levels sl
               where sl.organization_id = l.organization_id and sl.location_id = l.id
                 and sl.quantity >= 0), '[]'::jsonb)
       where l.organization_id = ${orgId}::uuid and l.id = ${loc}::uuid`);
  }
}

async function syncState(minutesAgo: number): Promise<void> {
  const t = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await db().execute(sql`
    update public.data_sources
       set cursor = ${JSON.stringify({ v: 1, lastSuccessAt: t, stockSyncedAt: t })}
     where organization_id = ${orgId}::uuid and id = ${sourceId}::uuid`);
}

/** Affärsdatan som fingeravtryck (kontrollen får aldrig ändra den). */
async function businessFingerprint(): Promise<string> {
  const r = await one<{ fp: string }>(
    db(),
    sql`select md5(concat_ws('|',
          (select count(*) || ':' || coalesce(sum(amount_ore), 0) || ':' || coalesce(max(updated_at)::text, '')
             from public.orders where organization_id = ${orgId}::uuid),
          (select count(*) || ':' || coalesce(sum(quantity), 0)
             from public.stock_events where organization_id = ${orgId}::uuid),
          (select count(*) || ':' || coalesce(sum(amount_ore), 0) || ':' || coalesce(max(updated_at)::text, '')
             from public.store_settlements where organization_id = ${orgId}::uuid),
          (select count(*) || ':' || coalesce(max(updated_at)::text, '')
             from public.purchase_prices where organization_id = ${orgId}::uuid),
          (select count(*) || ':' || coalesce(max(updated_at)::text, '')
             from public.machine_slots where organization_id = ${orgId}::uuid),
          (select coalesce(max(updated_at)::text, '') || md5(string_agg(coalesce(cursor, ''), ','))
             from public.data_sources where organization_id = ${orgId}::uuid),
          (select md5(coalesce(string_agg(coalesce(awish_fill::text, '') || awish_synced_at, ',' order by id), ''))
             from public.stock_locations where organization_id = ${orgId}::uuid),
          (select count(*) from public.automation_log where organization_id = ${orgId}::uuid)
        )) as fp`,
  );
  return r.fp;
}

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const seeded = await runSeed(db(), {
    password: "binderlab-kontroll",
    manageUsers: true,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-kontroll-"))),
    organization: { name: `Kontroll ${suffix}`, slug: `kontroll-${suffix}` },
    users: {
      owner: {
        email: `kontroll-agare-${suffix}@test.binderlab.se`,
        fullName: "Ägare",
        role: "owner",
      },
      partner: {
        email: `kontroll-delagare-${suffix}@test.binderlab.se`,
        fullName: "Delägare",
        role: "viewer",
      },
    },
  });
  orgId = seeded.organizationId;
  // Inställningarna är gjorda (kontroll 7): kortavgift 1,5 % och "Revisorn har koll".
  await db().execute(sql`
    insert into public.organization_settings (organization_id, card_fee_bp, vat_ok_at)
    values (${orgId}::uuid, 150, now())
    on conflict (organization_id) do update set card_fee_bp = 150, vat_ok_at = now()`);
  owner = { id: seeded.users.owner!, email: `kontroll-agare-${suffix}@test.binderlab.se` };
  const org = (await listOrganizationsFor({ userId: owner.id, email: owner.email })).find(
    (o) => o.id === orgId,
  );
  if (!org) throw new Error("Saknar medlemskap");
  ownerViewer = { user: { userId: owner.id, email: owner.email }, organization: org };
  viewer = await createMember(orgId, "viewer");
  refiller = await createMember(orgId, "refiller");

  for (const r of await rows<{ id: string; name: string }>(
    db(),
    sql`select id, name from public.stores where organization_id = ${orgId}::uuid`,
  ))
    storeIds.set(r.name, r.id);
  for (const r of await rows<{ id: string; code: string; loc: string }>(
    db(),
    sql`select m.id, m.code, l.id as loc from public.machines m
        join public.stock_locations l on l.organization_id = m.organization_id and l.machine_id = m.id
        where m.organization_id = ${orgId}::uuid`,
  )) {
    machineIds.set(r.code, r.id);
    locationIds.set(r.code, r.loc);
  }

  // Avtalen: vinstdelning 50 % (Spelbutiken), bara hyra (Gallerian), provision + hyra
  // (Kiosken) och en butik utan avtal.
  await db().execute(sql`
    update public.store_agreements a
       set commission_base = 'profit_after_costs', commission_bp = 5000, monthly_rent_ore = null
      from public.stores s
     where a.organization_id = ${orgId}::uuid and s.id = a.store_id
       and s.name = 'Spelbutiken Centrum (exempel)'`);
  await db().execute(
    sql`insert into public.stores (organization_id, name) values (${orgId}::uuid, 'Utan avtal')`,
  );
  // Alla titlar har inköpspris.
  await db().execute(sql`
    insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
    select t.organization_id, t.id, 9500, '2026-09-01'
      from public.titles t
     where t.organization_id = ${orgId}::uuid
       and not exists (select 1 from public.purchase_prices p
                        where p.organization_id = t.organization_id and p.title_id = t.id)`);

  // Awish: en API-källa med webbpush påslagen, BL-001 och BL-002 kopplade.
  sourceId = (
    await one<{ id: string }>(
      db(),
      sql`insert into public.data_sources (organization_id, provider, name, source_timezone, config)
          values (${orgId}::uuid, 'awish_grpc', 'Awish', 'Asia/Shanghai',
                  '{"awishWeb": {"enabled": true, "hasPassword": true}}'::jsonb)
          returning id`,
    )
  ).id;
  let ext = 1001;
  for (const code of ["BL-001", "BL-002"]) {
    await db().execute(sql`
      insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
      values (${orgId}::uuid, ${sourceId}::uuid, ${String(ext++)}, ${code}, ${machineIds.get(code)!}::uuid)`);
  }
  await syncState(3);

  // En påfyllning i BL-001 som nådde Awish (push loggad efter den).
  const title = await one<{ id: string }>(
    db(),
    sql`select title_id as id from public.stock_levels
        where organization_id = ${orgId}::uuid and location_id = ${locationIds.get("BL-001")!}::uuid
        order by title_id limit 1`,
  );
  await db().execute(sql`
    insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
    values (${orgId}::uuid, ${locationIds.get("BL-001")!}::uuid, ${title.id}::uuid, 'refill', 4, now())`);
  await db().execute(sql`
    insert into public.automation_log (organization_id, kind, machine_id, units)
    values (${orgId}::uuid, 'awish_push', ${machineIds.get("BL-001")!}::uuid, 1)`);
  await awishReadNow();

  // Obetalda avräkningar för oktober (avräkningsmotorn, som larmjobbet).
  await createMonthlySettlements(db(), new Date(), { organizationIds: [orgId], create: "always" });

  // Notiser: ägaren, läsaren och påfyllaren prenumererar på allt med push.
  for (const u of [owner, viewer, refiller]) {
    await db().execute(sql`
      insert into public.alert_subscriptions (organization_id, user_id, channels, min_severity, active)
      values (${orgId}::uuid, ${u.id}::uuid, array['push'], 'info', true)
      on conflict do nothing`);
  }
}, 240_000);

afterAll(() => {
  fault.butiker = false;
});

describe("daglig kontroll: allt stämmer", () => {
  it("alla sju kontroller går igenom, under 20 s, inget larm", async () => {
    const r = await run();
    // Felsökning: visa fynden om något inte stämmer.
    for (const c of r.checks) {
      if (c.status !== "pass") console.log(c.id, c.status, c.summary, c.findings);
    }
    expect(statuses(r)).toEqual({
      samma_vinst: "pass",
      awish_appen: "pass",
      pafyllning_awish: "pass",
      synk: "pass",
      avrakningar: "pass",
      datahygien: "pass",
      installningar: "pass",
    });
    expect(r.status).toBe("ok");
    expect(r.durationMs).toBeLessThan(20_000);
    expect(await openAlerts()).toEqual([]);
    // Alla sidor i båda lägena, andelen mot liggaren och mot avräkningarna för oktober, och
    // Värde för två månader: 3 × 16 + 4 + 4 jämförelser.
    expect(check(r, "samma_vinst").summary).toMatch(/\(56 jämförelser\)/);
    expect(check(r, "awish_appen").summary).toMatch(/i 2 automater/);
    expect(check(r, "pafyllning_awish").summary).toBe(
      "Påfyllningen det senaste dygnet skickades till Awish.",
    );
    expect(check(r, "avrakningar").summary).toMatch(/^3\u00a0obetalda avräkningar stämmer/);
  }, 60_000);

  it("skriver aldrig affärsdata: bara en resultatrad", async () => {
    const before = await businessFingerprint();
    const n = async () =>
      (
        await one<{ n: number }>(
          db(),
          sql`select count(*)::int as n from public.self_check_runs where organization_id = ${orgId}::uuid`,
        )
      ).n;
    const runs = await n();
    await run();
    expect(await businessFingerprint()).toBe(before);
    expect(await n()).toBe(runs + 1);
  }, 60_000);
});

/** Bryter en kontroll, kontrollerar larmet (ett, en gång, bara till ägaren) och rättar. */
async function breakAndFix(
  id: SelfCheckId,
  breakIt: () => Promise<void>,
  fixIt: () => Promise<void>,
  expectFinding: RegExp,
): Promise<void> {
  await breakIt();
  const broken = await run();
  const c = check(broken, id);
  expect(c.status, `${id}: ${c.summary}`).toBe("fail");
  expect(c.findings.some((f) => f.level === "fail" && expectFinding.test(f.text))).toBe(true);
  expect(broken.status).toBe("failed");
  const key = `self_check:${id}`;
  const open = (await openAlerts()).filter((a) => a.key === key);
  expect(open).toHaveLength(1);
  expect(open[0]!.occurrences).toBe(1);
  // Ägaren aviseras; läsaren (inte ägare/admin) och påfyllaren (bara automater) inte.
  expect(await deliveriesFor(open[0]!.id)).toEqual([owner.id]);

  // Samma fel nästa körning: samma larm, inget nytt utskick.
  await run();
  const again = (await openAlerts()).filter((a) => a.key === key);
  expect(again).toHaveLength(1);
  expect(again[0]!.id).toBe(open[0]!.id);
  expect(again[0]!.occurrences).toBe(2);
  expect(await deliveriesFor(open[0]!.id)).toEqual([owner.id]);

  await fixIt();
  const fixed = await run();
  expect(check(fixed, id).status, `${id} rättad: ${check(fixed, id).summary}`).not.toBe("fail");
  expect((await openAlerts()).filter((a) => a.key === key)).toEqual([]);
  const closed = await one<{ status: string }>(
    db(),
    sql`select status from public.alerts where id = ${open[0]!.id}::uuid`,
  );
  expect(closed.status).toBe("closed");
}

/** En order kopierad från en befintlig (ny extern id), med ändringar. */
async function copyOrder(
  where: ReturnType<typeof sql>,
  set: { titleId: string | null; day: string },
) {
  return one<{ id: string; machine_id: string }>(
    db(),
    sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                   ordered_at, business_date, amount_ore, payment_method,
                                   source_machine_id, machine_id, import_id, source_hash)
        select o.organization_id, o.data_source_id, 'kontroll-' || gen_random_uuid(), 'Okänd vara',
               ${set.titleId}::uuid, (${set.day}::date + time '12:00') at time zone 'Europe/Stockholm',
               ${set.day}::date, o.amount_ore, o.payment_method, o.source_machine_id, o.machine_id,
               null, md5(gen_random_uuid()::text)
        from public.orders o
        where o.organization_id = ${orgId}::uuid and ${where}
        order by o.ordered_at limit 1
        returning id, machine_id::text`,
  );
}

describe("daglig kontroll: varje kontroll bryts och rättas", () => {
  it("1. samma vinst: en sida som räknar en krona fel", async () => {
    await breakAndFix(
      "samma_vinst",
      async () => {
        fault.butiker = true;
      },
      async () => {
        fault.butiker = false;
      },
      /utan butikernas andel: Butiker rader visar .*\(\+1,00\u00a0kr\)/,
    );
  }, 120_000);

  it("1b. samma vinst: en skillnad som bara syns i en läsning (order synkad mitt i) ger inget fel", async () => {
    fault.butikerOnce = true;
    const r = await run();
    expect(fault.butikerOnce).toBe(false);
    expect(check(r, "samma_vinst").status).toBe("pass");
    expect((await openAlerts()).filter((a) => a.key === "self_check:samma_vinst")).toEqual([]);
  }, 120_000);

  it("2. Awish = appen: Awish visar färre pack än appen; en gammal läsning är bara en varning", async () => {
    await breakAndFix(
      "awish_appen",
      async () => {
        await db().execute(sql`
          update public.stock_locations
             set awish_fill = jsonb_set(awish_fill, '{0,units}',
                   to_jsonb(((awish_fill -> 0 ->> 'units')::int + 3)))
           where organization_id = ${orgId}::uuid and id = ${locationIds.get("BL-002")!}::uuid`);
      },
      async () => {
        await awishReadNow();
      },
      /^BL-002 .*: Awish \d+ pack, appen \d+ pack\.$/,
    );
    await db().execute(sql`
      update public.stock_locations set awish_synced_at = now() - interval '45 minutes'
       where organization_id = ${orgId}::uuid and id = ${locationIds.get("BL-001")!}::uuid`);
    const stale = await run();
    expect(check(stale, "awish_appen").status).toBe("warn");
    expect(check(stale, "awish_appen").findings[0]!.text).toMatch(/^BL-001: gammal läsning/);
    expect((await openAlerts()).filter((a) => a.key === "self_check:awish_appen")).toEqual([]);
    await awishReadNow();
  }, 120_000);

  it("3. påfyllningar: en påfyllning i BL-002 utan push till Awish", async () => {
    await breakAndFix(
      "pafyllning_awish",
      async () => {
        await db().execute(sql`
          insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
          select organization_id, location_id, title_id, 'refill', 3, now()
          from public.stock_levels
          where organization_id = ${orgId}::uuid and location_id = ${locationIds.get("BL-002")!}::uuid
          order by title_id limit 1`);
      },
      async () => {
        await db().execute(sql`
          insert into public.automation_log (organization_id, kind, machine_id, units)
          values (${orgId}::uuid, 'awish_push', ${machineIds.get("BL-002")!}::uuid, 1)`);
      },
      /^BL-002 .*: påfyllningen på 3 pack har inte nått Awish/,
    );
  }, 120_000);

  it("3b. påfyllningar: Awish visade redan påfyllningen (pushen hade inget att ändra) är inget fel; en läsning utan påfyllningen är det", async () => {
    const loc = locationIds.get("BL-002")!;
    const title = await one<{ id: string }>(
      db(),
      sql`select title_id as id from public.stock_levels
          where organization_id = ${orgId}::uuid and location_id = ${loc}::uuid
          order by title_id desc limit 1`,
    );
    // Pushen i förra testet ska ligga före påfyllningen (mer än klockmarginalen, 5 s).
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    await db().execute(sql`
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
      values (${orgId}::uuid, ${loc}::uuid, ${title.id}::uuid, 'refill', 2, now())`);
    // Läsningen från Awish efter påfyllningen.
    const readAfter = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await awishReadNow();
    };
    // Läsningen efter påfyllningen visar två pack för lite: pushen nådde inte fram.
    await readAfter();
    await db().execute(sql`
      update public.stock_locations l
         set awish_fill = (select jsonb_agg(case when (x ->> 'title_id')::uuid = ${title.id}::uuid
                                                 then jsonb_set(x, '{units}', to_jsonb((x ->> 'units')::int - 2))
                                                 else x end)
                             from jsonb_array_elements(l.awish_fill) x)
       where l.organization_id = ${orgId}::uuid and l.id = ${loc}::uuid`);
    let r = await run();
    expect(check(r, "pafyllning_awish").status).toBe("fail");
    // Awish visar påfyllningen (ingen push loggad: inget fack behövde ändras).
    await readAfter();
    r = await run();
    expect(check(r, "pafyllning_awish").status).toBe("pass");
    expect(check(r, "awish_appen").status).toBe("pass");
    expect((await openAlerts()).filter((a) => a.key === "self_check:pafyllning_awish")).toEqual([]);
  }, 120_000);

  it("4. synk: orderna har inte hämtats på tre timmar", async () => {
    await breakAndFix(
      "synk",
      () => syncState(180),
      () => syncState(3),
      /orderhämtningen lyckades senast för 3 h sedan/,
    );
  }, 120_000);

  it("5. avräkningar: en order utan inköpspris hos butiken med vinstdelning", async () => {
    const title = await one<{ id: string }>(
      db(),
      sql`insert into public.titles (organization_id, name)
          values (${orgId}::uuid, 'Kontroll utan pris') returning id`,
    );
    const spel = storeIds.get("Spelbutiken Centrum (exempel)")!;
    let machineId = "";
    await breakAndFix(
      "avrakningar",
      async () => {
        ({ machine_id: machineId } = await copyOrder(
          sql`o.machine_id in (select p.machine_id from public.machine_placements p
                               where p.organization_id = o.organization_id and p.store_id = ${spel}::uuid)
              and o.business_date between '2026-10-01' and '2026-10-31'`,
          { titleId: title.id, day: "2026-10-20" },
        ));
      },
      async () => {
        await db().execute(sql`
          insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
          values (${orgId}::uuid, ${title.id}::uuid, 9500, '2026-09-01')`);
        // Försäljningen drog ett pack ur automaten som aldrig fyllts på (datahygienen).
        await db().execute(sql`
          insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
          select l.organization_id, l.id, ${title.id}::uuid, 'adjustment', 1, now()
          from public.stock_locations l
          where l.organization_id = ${orgId}::uuid and l.machine_id = ${machineId}::uuid`);
      },
      /^Spelbutiken Centrum \(exempel\), oktober 2026: avräkningen går inte att räkna/,
    );
    // Det sparade beloppet har inte räknats om än: en varning, inget larm.
    const after = await run();
    expect(check(after, "avrakningar").status).toBe("warn");
    await createMonthlySettlements(db(), new Date(), {
      organizationIds: [orgId],
      create: "always",
    });
    expect(check(await run(), "avrakningar").status).toBe("pass");
  }, 120_000);

  it("6. datahygien: en order utan titel och ett negativt saldo i en automat", async () => {
    let orderId = "";
    const loc = locationIds.get("BL-003")!;
    const title = await one<{ id: string }>(
      db(),
      sql`select id from public.titles where organization_id = ${orgId}::uuid order by name limit 1`,
    );
    await breakAndFix(
      "datahygien",
      async () => {
        orderId = (await copyOrder(sql`true`, { titleId: null, day: "2026-11-01" })).id;
        await db().execute(sql`
          insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
          values (${orgId}::uuid, ${loc}::uuid, ${title.id}::uuid, 'adjustment', -1000, now())`);
      },
      async () => {
        await db().execute(sql`
          update public.orders set title_id = ${title.id}::uuid
           where organization_id = ${orgId}::uuid and id = ${orderId}::uuid`);
        await db().execute(sql`
          insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
          values (${orgId}::uuid, ${loc}::uuid, ${title.id}::uuid, 'adjustment', 1000, now())`);
      },
      /saknar titel/,
    );
  }, 120_000);

  it("efter rättningarna: allt stämmer igen och inga larm är öppna", async () => {
    const r = await run();
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(await openAlerts()).toEqual([]);
  }, 60_000);
});

describe("daglig kontroll: demo", () => {
  it("en demo larmar i appen men skickar ingenting", async () => {
    await db().execute(
      sql`update public.organizations set is_demo = true where id = ${orgId}::uuid`,
    );
    try {
      fault.butiker = true;
      const r = await run();
      expect(check(r, "samma_vinst").status).toBe("fail");
      const [alert] = (await openAlerts()).filter((a) => a.key === "self_check:samma_vinst");
      expect(alert).toBeDefined();
      expect(await deliveriesFor(alert!.id)).toEqual([]);
    } finally {
      fault.butiker = false;
      await db().execute(
        sql`update public.organizations set is_demo = false where id = ${orgId}::uuid`,
      );
    }
    await run();
    expect(await openAlerts()).toEqual([]);
  }, 120_000);
});

describe("daglig kontroll: behörighet och RLS", () => {
  async function viewerOf(user: TestUser): Promise<Viewer> {
    const org = (await listOrganizationsFor({ userId: user.id, email: user.email })).find(
      (o) => o.id === orgId,
    )!;
    return { user: { userId: user.id, email: user.email }, organization: org };
  }

  it("ägaren läser senaste körningen; läsaren och påfyllaren nekas eller ser ingenting", async () => {
    const page = await loadSelfCheckFor(ownerViewer);
    expect(page.latest?.checks.map((c) => c.id)).toEqual([
      "samma_vinst",
      "awish_appen",
      "pafyllning_awish",
      "synk",
      "avrakningar",
      "datahygien",
      "installningar",
    ]);
    expect(page.history.length).toBeGreaterThan(5);
    expect(await latestSelfCheckFor(ownerViewer)).toMatchObject({ status: "ok", failed: 0 });
    for (const u of [viewer, refiller]) {
      await expect(loadSelfCheckFor(await viewerOf(u))).rejects.toBeInstanceOf(AuthorizationError);
      // Hem för läsaren: ingen rad (RLS), inget fel.
      expect(await latestSelfCheckFor(await viewerOf(u))).toBeNull();
    }
  });

  it("RLS: bara ägare och admin läser, ingen klientroll skriver", async () => {
    const count = (u: TestUser) =>
      asUser(u, (tx) =>
        one<{ n: number }>(
          tx,
          sql`select count(*)::int as n from public.self_check_runs where organization_id = ${orgId}::uuid`,
        ),
      );
    expect((await count(owner)).n).toBeGreaterThan(0);
    const admin = await createMember(orgId, "admin");
    expect((await count(admin)).n).toBeGreaterThan(0);
    expect((await count(viewer)).n).toBe(0);
    expect((await count(refiller)).n).toBe(0);
    // Ägare i en annan organisation ser inget.
    const outsider = await createUser();
    await createOrg(outsider, "Annan");
    expect((await count(outsider)).n).toBe(0);
    for (const u of [owner, admin]) {
      const ins = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`insert into public.self_check_runs (organization_id, trigger, status)
                         values (${orgId}::uuid, 'manual', 'ok')`),
        ),
      );
      expect(ins.ok).toBe(false);
      const upd = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`update public.self_check_runs set status = 'ok'
                         where organization_id = ${orgId}::uuid`),
        ),
      );
      expect(upd.ok).toBe(false);
      const del = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`delete from public.self_check_runs where organization_id = ${orgId}::uuid`,
          ),
        ),
      );
      expect(del.ok).toBe(false);
    }
  });

  it("Kör kontrollen nu: ägaren kör (en gång i minuten), läsaren och påfyllaren nekas", async () => {
    for (const u of [viewer, refiller]) {
      await expect(runSelfCheckNowFor(await viewerOf(u), { db: db() })).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    }
    const r = await runSelfCheckNowFor(ownerViewer, { db: db(), now: at() });
    expect(r.status).toBe("ok");
    const row = await one<{ trigger: string; created_by: string }>(
      db(),
      sql`select trigger, created_by::text from public.self_check_runs where id = ${r.id!}::uuid`,
    );
    expect(row).toEqual({ trigger: "manual", created_by: owner.id });
    await expect(runSelfCheckNowFor(ownerViewer, { db: db(), now: at() })).rejects.toBeInstanceOf(
      SelfCheckBusyError,
    );
  }, 60_000);
});

describe("daglig kontroll: schemat", () => {
  it("körs en gång per dag från kl. 05 lokal tid", async () => {
    // I dag har kontrollen redan körts schemalagt (eller är det före 05).
    const today = await runScheduledSelfChecks(db(), new Date(), { only: [orgId] });
    expect(today.organizations).toEqual([
      expect.objectContaining({ organizationId: orgId, status: "skipped" }),
    ]);
    // I morgon 04:00 svensk tid (03:00 UTC i november): för tidigt.
    // Svensk kalenderdag (inte UTC): mellan 00 och 01 svensk tid är UTC-dagen fortfarande i går.
    const todaySe = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
    const day = new Date(Date.parse(`${todaySe}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const early = await runScheduledSelfChecks(db(), new Date(`${day}T03:00:00Z`), {
      only: [orgId],
    });
    expect(early.organizations[0]).toMatchObject({ status: "skipped", reason: "not_yet" });
    // I morgon 05:37 svensk tid: körs.
    const due = await runScheduledSelfChecks(db(), new Date(`${day}T04:37:00Z`), { only: [orgId] });
    expect(due.organizations[0]!.status).not.toBe("skipped");
    const again = await runScheduledSelfChecks(db(), new Date(`${day}T05:37:00Z`), {
      only: [orgId],
    });
    expect(again.organizations[0]).toMatchObject({ status: "skipped", reason: "already_ran" });
  }, 120_000);
});
