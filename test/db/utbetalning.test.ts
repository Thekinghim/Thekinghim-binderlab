/**
 * Butiker → Utbetalning och butiker utan avtal, mot testdatabasen:
 *
 * - en butik med automat men utan avtal räknas som 0 %: sidan varnar, "Skapa" frågar först
 *   (servern skapar inget utan bekräftelsen) och avräkningen blir 0 kr om ägaren skapar ändå,
 * - Att göra: "Skapa mars-avräkningarna" när månaden är slut och avräkningarna saknas, en
 *   punkt för butiken utan avtal (ihop med kontraktspunkten), och "Betala …: X kr senast …"
 *   med beloppet som avräkningen räknar,
 * - Daglig kontroll (datahygien) hittar butiken utan avtal med samma regel.
 *
 * Fixturens order ligger i mars 2025; den 2 april avräknas mars.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { listOrganizationsFor, type SessionUser } from "@/server/access";
import { loadTodosFor, type Viewer } from "@/server/data/core/loaders";
import { queryAgreementGaps } from "@/server/self-check/queries";
import { ensureSettlementsFor, loadSettlementPageFor } from "@/server/settlements/service";

import { asPostgres, db, one, rows, type TestUser } from "./helpers";
import { seedPortalTenant, type PortalTenant } from "./portal-fixture";

const APRIL = new Date("2025-04-02T08:00:00Z");
const plain = (t: string) => t.replace(/ /g, " ");

let t: PortalTenant;
let owner: Viewer;
let noDealId: string;

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

beforeAll(async () => {
  t = await seedPortalTenant("ICA Utbetalning");
  owner = await viewerFor(t.owner, t.orgId);
  // En butik utan avtal där BL-002 står sedan 20 mars (och säljer 99 kr den 21:a).
  noDealId = await asPostgres(async (tx) => {
    const store = await one<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name)
          values (${t.orgId}, 'Hörnan utan avtal') returning id`,
    );
    const machine = await one<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${t.orgId}, 'BL-002', 'Automat 2', '2025-03-20') returning id`,
    );
    await tx.execute(
      sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
          values (${t.orgId}, ${machine.id}, ${store.id}, '2025-03-20')`,
    );
    const src = await one<{ id: string }>(
      tx,
      sql`select id from public.data_sources where organization_id = ${t.orgId} limit 1`,
    );
    const title = await one<{ id: string }>(
      tx,
      sql`select id from public.titles where organization_id = ${t.orgId} order by name limit 1`,
    );
    await tx.execute(
      sql`insert into public.orders (organization_id, data_source_id, external_id, raw_title, title_id,
                                     ordered_at, amount_ore, machine_id, source_hash)
          values (${t.orgId}, ${src.id}, '42099', 'Pokemon 151', ${title.id},
                  '2025-03-21T10:00:00Z', 9900, ${machine.id}, 'h-utan-avtal')`,
    );
    return store.id;
  });
});

describe("butik utan avtal före avräkningen", () => {
  it("sidan varnar: butiken räknas som 0 % hela månaden", async () => {
    const page = await loadSettlementPageFor(owner, APRIL);
    expect(page.missing.map((m) => m.storeId).sort()).toEqual([noDealId, t.storeId].sort());
    expect(page.noAgreement).toEqual([
      { storeId: noDealId, storeName: "Hörnan utan avtal", days: 12, whole: true },
    ]);
  });

  it("Att göra: skapa mars-avräkningarna och butiken utan avtal (en punkt per butik)", async () => {
    const todos = await loadTodosFor(owner, APRIL);
    const create = todos.find((x) => x.kind === "settlement-create")!;
    expect(create).toMatchObject({
      key: "settlement-create:2025-03",
      title: "Skapa mars-avräkningarna",
      level: "now",
      link: "/butiker?vy=utbetalning&manad=2025-03",
    });
    const about = todos.filter((x) => x.evidence.storeIds.includes(noDealId) && x !== create);
    // Ingen avtalspunkt OCH kontraktspunkt: kontraktspunkten säger båda (Skapa kontrakt
    // lägger in avtalet).
    expect(about).toHaveLength(1);
    expect(plain(about[0]!.title)).toMatch(/Hörnan utan avtal .*räknas som 0 %/);
    expect(todos.some((x) => x.kind === "settlement")).toBe(false);
  });

  it("Skapa frågar först (inget skapas); bekräftat blir avräkningen 0 kr", async () => {
    const first = await ensureSettlementsFor(owner, APRIL);
    expect(first).toMatchObject({ created: 0 });
    expect(first?.noAgreement).toEqual([
      { storeId: noDealId, storeName: "Hörnan utan avtal", days: 12, whole: true },
    ]);
    const none = await asPostgres((tx) =>
      rows(tx, sql`select id from public.store_settlements where organization_id = ${t.orgId}`),
    );
    expect(none).toHaveLength(0);

    const run = await ensureSettlementsFor(owner, APRIL, { allowNoAgreement: true });
    expect(run).toMatchObject({ created: 2, errors: [] });
    expect(run?.noAgreement).toBeUndefined();
    const amounts = await asPostgres((tx) =>
      rows<{ store_id: string; amount_ore: string }>(
        tx,
        sql`select store_id, amount_ore from public.store_settlements
            where organization_id = ${t.orgId}`,
      ),
    );
    const by = new Map(amounts.map((r) => [r.store_id, Number(r.amount_ore)]));
    expect(by.get(noDealId)).toBe(0);
    expect(by.get(t.storeId)).toBeGreaterThan(0);
  });

  it("Att göra efteråt: 'Betala …: X kr senast 15 apr.' med avräkningens belopp", async () => {
    const todos = await loadTodosFor(owner, APRIL);
    expect(todos.some((x) => x.kind === "settlement-create")).toBe(false);
    const pay = todos.find((x) => x.kind === "settlement")!;
    const page = await loadSettlementPageFor(owner, APRIL);
    const unpaid = page.rows.filter((r) => r.state === "unpaid");
    expect(unpaid).toHaveLength(1);
    const amount = unpaid[0]!.amountOre;
    const kr = Math.round(amount / 100)
      .toLocaleString("sv-SE")
      .replace(/\s/g, " ");
    expect(plain(pay.title).replace(/\s/g, " ")).toBe(
      `Betala ICA Utbetalning: ${kr} kr senast 15 apr.`,
    );
    expect(pay.link).toBe("/butiker?vy=utbetalning&manad=2025-03");
    // Sidan varnar på 0 kr-raden att butiken saknade avtal.
    expect(page.noAgreement.map((g) => g.storeId)).toEqual([noDealId]);
  });

  it("Daglig kontroll: samma regel hittar butiken utan avtal", async () => {
    const gaps = await queryAgreementGaps(db(), t.orgId, {
      start: "2025-03-01",
      end: "2025-03-31",
    });
    expect(gaps).toEqual([
      { storeId: noDealId, storeName: "Hörnan utan avtal", days: 12, whole: true },
    ]);
  });
});
