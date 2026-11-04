/**
 * Titlar som gått ur automaten (Utgår på Lager) mot testdatabasen, som produktionen 4 nov.
 * 2026: Black bolt har sålt i BL-201 sedan 14 okt. men facket togs bort 2 nov. (0 kvar i
 * automaten, 8 pack hemma); 30th Celebration säljer vidare. Samma utgår-regel överallt:
 *
 * - larmjobbet ger inget "Kritisk – slut" för Black bolt (men larmar som förut annars),
 * - Vårt lager visar Black bolt som Utgår och räknar de 8 packen som "Ligger still",
 * - Prognos & inköp ger ingen prognos och inget inköpsbehov för Black bolt.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "@/db/schema";
import { listOrganizationsFor } from "@/server/access";
import { collectCandidates } from "@/server/alerts/evaluate";
import type { Viewer } from "@/server/data/core/loaders";
import { loadPrognosFor } from "@/server/purchasing/load";
import { loadVartLagerFor } from "@/app/(app)/vart-lager/_lib/data";

import { asPostgres, createOrg, createUser, db, uniqueSuffix, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

/** Onsdag 4 nov. 2026 10:00 svensk tid. */
const NOW = new Date("2026-11-04T09:00:00Z");
const TZ = "Europe/Stockholm";

let owner: TestUser;
let orgId: string;
let machineId: string;
let bolt: string;
let thirty: string;

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

beforeAll(async () => {
  owner = await createUser(`utgar-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Utgår ${uniqueSuffix()}`);
  await asPostgres(async (tx) => {
    const org = { organizationId: orgId };
    const [m] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-201", name: "Sega gubbens automat", activeFrom: "2026-10-14" })
      .returning({ id: s.machines.id });
    machineId = m!.id;
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Sega gubben" })
      .returning({ id: s.stores.id });
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId, storeId: store!.id, validFrom: "2026-10-14" });
    const titles = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Black bolt" },
        { ...org, name: "30th Celebration" },
      ])
      .returning({ id: s.titles.id });
    bolt = titles[0]!.id;
    thirty = titles[1]!.id;
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning({ id: s.dataSources.id });
    await tx.execute(sql`
      insert into public.machine_slots (organization_id, machine_id, title_id, slots, valid_from, valid_to)
      values (${orgId}::uuid, ${machineId}::uuid, ${bolt}::uuid, 1, '2026-10-14', '2026-11-02'),
             (${orgId}::uuid, ${machineId}::uuid, ${thirty}::uuid, 2, '2026-10-14', null)`);
    // Black bolt 1 per dag 14–30 okt., 30th 2 per dag 14 okt.–3 nov. (kl. 12 svensk tid).
    await tx.execute(sql`
      insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                 ordered_at, amount_ore, machine_id, source_hash)
      select ${orgId}::uuid, ${source!.id}::uuid, x.code || '-' || to_char(g.d, 'YYYYMMDD') || '-' || k,
             x.name, x.title_id, (g.d + time '12:00') at time zone 'Europe/Stockholm', 19900,
             ${machineId}::uuid, 'test'
      from (values (${bolt}::uuid, 'Black bolt', 'B', 1, date '2026-10-30'),
                   (${thirty}::uuid, '30th Celebration', 'T', 2, date '2026-11-03'))
             as x(title_id, name, code, per_day, last)
      cross join lateral generate_series(date '2026-10-14', x.last, interval '1 day') g(d)
      cross join lateral generate_series(1, x.per_day) k`);
    // Saldon: Black bolt 0 i automaten (facket borta), 30th 40; hemma 8 och 50.
    await tx.execute(sql`
      insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
      select ${orgId}::uuid, l.id, v.title_id, 'count', v.q, '2026-11-03T20:00:00Z'::timestamptz, 'Räknat'
      from public.stock_locations l
      join (values (${bolt}::uuid, 0, true), (${thirty}::uuid, 40, true),
                   (${bolt}::uuid, 8, false), (${thirty}::uuid, 50, false)) v(title_id, q, in_machine)
        on (v.in_machine and l.machine_id = ${machineId}::uuid)
        or (not v.in_machine and l.is_central)
      where l.organization_id = ${orgId}::uuid`);
  });
});

describe("utgångna titlar: samma regel i larm, Vårt lager och Prognos", () => {
  it("larmjobbet: inget 'Kritisk – slut' för Black bolt", async () => {
    const { candidates } = await db().transaction((tx) => collectCandidates(tx, orgId, TZ, NOW));
    const low = candidates.filter((c) => c.kind === "low_stock");
    expect(low.map((c) => c.titleId)).not.toContain(bolt);
  });

  it("Vårt lager: Black bolt Utgår, 8 pack ligger still, inget att beställa", async () => {
    const model = await loadVartLagerFor(await viewerFor(owner, orgId), NOW);
    const row = model.rows.find((r) => r.titleId === bolt)!;
    expect(row).toMatchObject({ retired: true, runsOut: false, home: 8, lastsDays: null });
    expect(model.rows.at(-1)!.titleId).toBe(bolt);
    expect(model.totals.idle).toMatchObject({ titles: 1, packs: 8 });
    expect(model.rows.find((r) => r.titleId === thirty)!.retired).toBe(false);
  });

  it("Prognos & inköp: ingen prognos eller inköpsbehov för Black bolt", async () => {
    const data = await loadPrognosFor(
      await viewerFor(owner, orgId),
      { period: { start: "2026-10-06", end: "2026-11-04" } },
      NOW,
    );
    expect(data.forecast.series.map((x) => x.titleId)).toEqual([thirty]);
    const line = data.plan.lines.find((l) => l.titleId === bolt);
    expect(line?.status ?? "no-demand").toBe("no-demand");
  });
});
