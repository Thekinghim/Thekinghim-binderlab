/**
 * Runda 2, T6-6 mot testdatabasen: gissningen sparas på platsen när den blir butik
 * (migreringen 20261206000000_gissning_pa_plats.sql, src/app/(app)/butiker/ny/_lib/guess.ts).
 * Den är samma uppskattning som Expansion visar, sparas en gång och ändras inte när
 * butikernas försäljning ändras efteråt.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { leadGuessFor, leadGuessSafe, saveLeadGuess } from "@/app/(app)/butiker/ny/_lib/guess";
import { addDays, type IsoDate } from "@/domain";
import { listOrganizationsFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";

import { asPostgres, asUser, attempt, createMember, one, type TestUser } from "./helpers";
import { awishCsv, mapMachine, setupImportOrg, type ImportFixture } from "./import-fixtures";

let f: ImportFixture;
let owner: Viewer;
let today: IsoDate;
let leadId: string;

async function viewerFor(u: TestUser): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === f.orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

/** Ett köp per dag (källans klockslag, Asia/Shanghai: kl. 18 är samma dag i Sverige). */
function dailyOrders(from: number, to: number, prefix: string, amount = "Amount: 170.00") {
  const rows = [];
  for (let d = from; d <= to; d++) {
    rows.push({
      no: `${prefix}${d}`,
      name: "Booster",
      machine: "BL-001 Kiosken",
      amount,
      time: `${addDays(today, -d)} 18:00:00`,
    });
  }
  return awishCsv(rows);
}

async function storedGuess() {
  return one<{
    guess_profit_month_ore: string | number | null;
    guess_low_month_ore: string | number | null;
    guess_high_month_ore: string | number | null;
    guess_on: string | null;
  }>(
    asPostgresDb,
    sql`select guess_profit_month_ore, guess_low_month_ore, guess_high_month_ore,
               guess_on::text as guess_on
        from public.expansion_leads where id = ${leadId}::uuid`,
  );
}

// Läses som systemet (utan RLS), så att testet ser vad som faktiskt står i tabellen.
let asPostgresDb: Parameters<typeof one>[0];

beforeAll(async () => {
  f = await setupImportOrg();
  owner = await viewerFor(f.owner);
  today = businessToday(new Date(), owner.organization.timezone);
  const { db } = await import("./helpers");
  asPostgresDb = db();
  const machineId = await mapMachine(f, "BL-001 Kiosken", "BL-001");
  // En butik i drift (kiosk i Lund) med automaten sedan 60 dagar.
  await asUser(f.owner, async (tx) => {
    const st = await one<{ id: string }>(
      tx,
      sql`insert into public.stores
            (organization_id, name, store_type, city, open_hours_per_week, area_sqm)
          values (${f.orgId}::uuid, 'Kiosken', 'kiosk', 'Lund', 60, 100) returning id`,
    );
    await tx.execute(
      sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
          values (${f.orgId}::uuid, ${machineId}::uuid, ${st.id}::uuid, ${addDays(today, -60)})`,
    );
  });
  // Ett köp om dagen de senaste 40 dagarna (t.o.m. i går), 170 kr, inköp 100 kr.
  const r = await f.run(dailyOrders(1, 40, "a"));
  expect(r.summary?.new).toBe(40);
  await asUser(f.owner, async (tx) => {
    const title = await one<{ id: string }>(
      tx,
      sql`select id from public.titles where organization_id = ${f.orgId}::uuid and name = 'Booster'`,
    );
    await tx.execute(
      sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
          values (${f.orgId}::uuid, ${title.id}::uuid, 10000, '2025-01-01')`,
    );
    // Platsen i pipelinen: en likadan kiosk i Lund.
    const lead = await one<{ id: string }>(
      tx,
      sql`insert into public.expansion_leads
            (organization_id, name, store_type, city, open_hours_per_week, area_sqm)
          values (${f.orgId}::uuid, 'Nya kiosken', 'kiosk', 'Lund', 60, 100) returning id`,
    );
    leadId = lead.id;
  });
});

describe("Gissningen sparas när platsen blir butik", () => {
  let first: NonNullable<Awaited<ReturnType<typeof leadGuessFor>>>;

  it("gissningen är Expansions uppskattning: vinst per månad med lägsta och högsta", async () => {
    const guess = await leadGuessFor(owner, leadId);
    expect(guess).not.toBeNull();
    first = guess!;
    expect(first.on).toBe(today);
    // Ett köp om dagen med 70 kr kvar per pack: ungefär 2 100 kr per månad.
    expect(first.profitPerMonthOre).toBeGreaterThan(150_000);
    expect(first.profitPerMonthOre).toBeLessThan(250_000);
    expect(first.lowOre).toBeLessThanOrEqual(first.profitPerMonthOre);
    expect(first.highOre).toBeGreaterThanOrEqual(first.profitPerMonthOre);
    // Inget är sparat förrän platsen blir butik.
    expect(await storedGuess()).toEqual({
      guess_profit_month_ore: null,
      guess_low_month_ore: null,
      guess_high_month_ore: null,
      guess_on: null,
    });
  });

  it("okänd plats eller en plats utan liknande butik: ingen gissning", async () => {
    expect(await leadGuessFor(owner, "00000000-0000-4000-8000-000000000000")).toBeNull();
    const odd = await asUser(f.owner, (tx) =>
      one<{ id: string }>(
        tx,
        sql`insert into public.expansion_leads (organization_id, name, store_type, city)
            values (${f.orgId}::uuid, 'Gym i Kiruna', 'gym', 'Kiruna') returning id`,
      ),
    );
    expect(await leadGuessFor(owner, odd.id)).toBeNull();
  });

  it("sparas på platsen, som ägaren, när den blir butik", async () => {
    const saved = await asUser(f.owner, (tx) => saveLeadGuess(tx, f.orgId, leadId, first));
    expect(saved).toBe(true);
    const row = await storedGuess();
    expect(Number(row.guess_profit_month_ore)).toBe(first.profitPerMonthOre);
    expect(Number(row.guess_low_month_ore)).toBe(first.lowOre);
    expect(Number(row.guess_high_month_ore)).toBe(first.highOre);
    expect(row.guess_on).toBe(today);
  });

  it("står kvar oförändrad när butikernas försäljning ändras efteråt", async () => {
    // Butiken säljer plötsligt mycket mer: uppskattningen i dag blir en annan.
    const r = await f.run(dailyOrders(1, 25, "b", "Amount: 900.00"));
    expect(r.summary?.new).toBe(25);
    const now = await leadGuessFor(owner, leadId);
    expect(now!.profitPerMonthOre).toBeGreaterThan(first.profitPerMonthOre * 2);
    // Den sparade gissningen är den gamla, och ett nytt försök att spara skriver inte över.
    const again = await asUser(f.owner, (tx) => saveLeadGuess(tx, f.orgId, leadId, now!));
    expect(again).toBe(false);
    expect(Number((await storedGuess()).guess_profit_month_ore)).toBe(first.profitPerMonthOre);
  });

  it("läsaren kan inte spara, och påfyllaren får ingen gissning", async () => {
    const other = await asUser(f.owner, (tx) =>
      one<{ id: string }>(
        tx,
        sql`insert into public.expansion_leads
              (organization_id, name, store_type, city, open_hours_per_week, area_sqm)
            values (${f.orgId}::uuid, 'Kiosk två', 'kiosk', 'Lund', 60, 100) returning id`,
      ),
    );
    const reader = await createMember(f.orgId, "viewer");
    const saved = await asUser(reader, (tx) => saveLeadGuess(tx, f.orgId, other.id, first));
    expect(saved).toBe(false);
    const refiller = await viewerFor(await createMember(f.orgId, "refiller"));
    expect(await leadGuessSafe(refiller, other.id)).toBeNull();
  });

  it("databasen kräver alla fyra värden tillsammans, och låg ≤ förväntad ≤ hög", async () => {
    await asPostgres(async (tx) => {
      const partial = await attempt(tx, (sp) =>
        sp.execute(
          sql`update public.expansion_leads
              set guess_low_month_ore = null where id = ${leadId}::uuid`,
        ),
      );
      expect(partial.ok).toBe(false);
      const order = await attempt(tx, (sp) =>
        sp.execute(
          sql`update public.expansion_leads
              set guess_low_month_ore = 500, guess_profit_month_ore = 100,
                  guess_high_month_ore = 900
              where id = ${leadId}::uuid`,
        ),
      );
      expect(order.ok).toBe(false);
    });
  });
});
