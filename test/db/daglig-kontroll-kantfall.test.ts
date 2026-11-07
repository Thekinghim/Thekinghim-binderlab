/**
 * Daglig kontroll, kontroll 1 ("Samma vinst överallt"): inga falsklarm i kantfall som
 * grundtesten (daglig-kontroll.test.ts) inte har: återbetalningar, en automat som flyttats
 * ut ur butiken, en automat som aldrig stått i en butik, en arkiverad automat och butik,
 * en order strax efter midnatt lokal tid den första i månaden, en organisation i en annan
 * tidszon och en tom organisation.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

import { LocalFileStore } from "@/import/file-store";
import { runSelfCheck, type SelfCheckRunResult } from "@/server/self-check/run";
import { createMonthlySettlements } from "@/server/settlements/service";
import { runSeed } from "@/seed/run-seed";

import { createOrg, createUser, db, one, rows, uniqueSuffix } from "./helpers";

let orgId: string;
const machineIds = new Map<string, string>();

const at = () => new Date(Date.now() + 10 * 60_000);

async function run(org = orgId): Promise<SelfCheckRunResult> {
  return runSelfCheck({ db: db(), now: at() }, { organizationId: org, trigger: "schedule" });
}

function profit(r: SelfCheckRunResult) {
  const c = r.checks.find((x) => x.id === "samma_vinst")!;
  return { status: c.status, findings: c.findings.map((f) => f.text) };
}

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const seeded = await runSeed(db(), {
    password: "binderlab-kontroll",
    manageUsers: true,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-granskning-"))),
    organization: { name: `Granskning ${suffix}`, slug: `granskning-${suffix}` },
    users: {
      owner: {
        email: `granskning-agare-${suffix}@test.binderlab.se`,
        fullName: "Ägare",
        role: "owner",
      },
      partner: {
        email: `granskning-delagare-${suffix}@test.binderlab.se`,
        fullName: "Delägare",
        role: "viewer",
      },
    },
  });
  orgId = seeded.organizationId;
  for (const r of await rows<{ id: string; code: string }>(
    db(),
    sql`select id, code from public.machines where organization_id = ${orgId}::uuid`,
  ))
    machineIds.set(r.code, r.id);
  await db().execute(sql`
    insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
    select t.organization_id, t.id, 9500, '2026-09-01'
      from public.titles t
     where t.organization_id = ${orgId}::uuid
       and not exists (select 1 from public.purchase_prices p
                        where p.organization_id = t.organization_id and p.title_id = t.id)`);
  await createMonthlySettlements(db(), new Date(), { organizationIds: [orgId], create: "always" });
}, 240_000);

describe("kontroll 1: kantfall", () => {
  it("grundläget går igenom", async () => {
    expect(profit(await run())).toEqual({ status: "pass", findings: [] });
  });

  it("återbetalningar i perioden: inget falsklarm", async () => {
    const m = machineIds.get("BL-001")!;
    await db().execute(sql`
      insert into public.incidents (organization_id, machine_id, kind, started_at, ended_at,
                                    status, refunded_ore, refunded_on)
      values (${orgId}::uuid, ${m}::uuid, 'other', now() - interval '20 days', now() - interval '20 days', 'resolved', 4900,
              (now() - interval '20 days')::date),
             (${orgId}::uuid, ${m}::uuid, 'other', now() - interval '1 day', now() - interval '1 day', 'resolved', 2500,
              (now() - interval '1 day')::date)`);
    const p = profit(await run());
    expect(p).toEqual({ status: "pass", findings: [] });
  });

  it("en automat som flyttats ut ur butiken (ingen placering i dag): inget falsklarm", async () => {
    const m = machineIds.get("BL-003")!;
    await db().execute(sql`
      update public.machine_placements set valid_to = (now() - interval '5 days')::date
       where organization_id = ${orgId}::uuid and machine_id = ${m}::uuid and valid_to is null`);
    const p = profit(await run());
    expect(p).toEqual({ status: "pass", findings: [] });
  });

  it("en automat som aldrig stått i en butik säljer: varning (koppla automaten), inget fel", async () => {
    const m = await one<{ id: string }>(
      db(),
      sql`insert into public.machines (organization_id, code, name)
          values (${orgId}::uuid, 'BL-099', 'Lagret') returning id`,
    );
    await db().execute(sql`
      insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                 ordered_at, business_date, amount_ore, machine_id, source_hash)
      select o.organization_id, o.data_source_id, 'kantfall-' || g, o.raw_title, o.title_id,
             now() - (g || ' days')::interval, (now() - (g || ' days')::interval)::date,
             o.amount_ore, ${m.id}::uuid, md5('kantfall-' || g)
        from (select * from public.orders where organization_id = ${orgId}::uuid
               and title_id is not null order by ordered_at desc limit 1) o,
             generate_series(1, 3) g`);
    const p = profit(await run());
    expect(p.status).toBe("warn");
    expect(p.findings).toEqual([
      expect.stringMatching(
        /^Senaste 30 dagarna: .* vinst i automater utan butik syns inte på Butiker/,
      ),
    ]);
    // Automaten kopplas till en butik: allt stämmer igen.
    await db().execute(sql`
      insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
      select ${orgId}::uuid, ${m.id}::uuid, s.id, (now() - interval '400 days')::date
        from public.stores s where s.organization_id = ${orgId}::uuid order by s.name limit 1`);
    expect(profit(await run())).toEqual({ status: "pass", findings: [] });
  });

  it("en order 00:30 svensk tid den första i månaden: inget falsklarm", async () => {
    await db().execute(sql`
      insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                 ordered_at, business_date, amount_ore, machine_id, source_hash)
      select o.organization_id, o.data_source_id, 'midnatt', o.raw_title, o.title_id,
             (date_trunc('month', now() at time zone 'Europe/Stockholm') + interval '30 minutes')
               at time zone 'Europe/Stockholm',
             date_trunc('month', now() at time zone 'Europe/Stockholm')::date,
             o.amount_ore, o.machine_id, md5('midnatt')
        from public.orders o where o.organization_id = ${orgId}::uuid and o.title_id is not null
          and o.machine_id = ${machineIds.get("BL-001")!}::uuid
        order by o.ordered_at desc limit 1`);
    const p = profit(await run());
    expect(p).toEqual({ status: "pass", findings: [] });
  });

  it("arkiverad automat och butik med försäljning i perioden: inget falsklarm", async () => {
    const m = machineIds.get("BL-002")!;
    await db().execute(
      sql`update public.machines set archived_at = now() where organization_id = ${orgId}::uuid and id = ${m}::uuid`,
    );
    await db().execute(sql`
      update public.stores set archived_at = now()
       where organization_id = ${orgId}::uuid and id = (
         select store_id from public.machine_placements
          where organization_id = ${orgId}::uuid and machine_id = ${m}::uuid
          order by valid_from desc limit 1)`);
    const p = profit(await run());
    expect(p).toEqual({ status: "pass", findings: [] });
  });

  it("annan tidszon: inget falsklarm", async () => {
    await db().execute(
      sql`update public.organizations set timezone = 'America/Los_Angeles' where id = ${orgId}::uuid`,
    );
    const p = profit(await run());
    await db().execute(
      sql`update public.organizations set timezone = 'Europe/Stockholm' where id = ${orgId}::uuid`,
    );
    expect(p).toEqual({ status: "pass", findings: [] });
  });

  it("tom organisation: kör utan fel", async () => {
    const u = await createUser();
    const empty = await createOrg(u, "Tom");
    const r = await run(empty);
    expect(r.status).not.toBe("error");
    expect(r.failed).toBe(0);
    const n = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.alerts where organization_id = ${empty}::uuid`,
    );
    expect(n.n).toBe(0);
  });
});
