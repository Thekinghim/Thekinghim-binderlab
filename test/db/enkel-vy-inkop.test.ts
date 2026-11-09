/**
 * Enkel vy för delägaren som köper in, mot testdatabasen. Delägaren är ägare i datan men
 * har Enkel vy (memberships.view_mode = 'simple'). I sin vy ser och använder hon Lager,
 * Inköpslistan och Inköpspriserna, med samma tjänster som ägarens sidor:
 *
 * - Lager: rätta antalet (setHomeCountFor) och leverans in (registerReceiptFor) i Hemma
 *   och i ett andra lager (Kontoret); laddaren (loadVartLagerFor) ger Inköps antal.
 * - Inköpspriser: nytt pris från i dag (addPurchasePriceFor) och Rätta priset
 *   (correctPurchasePriceFor); laddaren (loadPricePageFor) läser priserna.
 * - Mystery packs: "Sätt inköpspris" (setMysteryCostFor).
 *
 * Teamlåset (BL132) är kvar: hon ändrar inte teamet. En läsare med Enkel vy ändrar varken
 * lagret eller priserna (samma roller som i hela appen).
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";
import { loadVartLagerFor } from "../../src/app/(app)/vart-lager/_lib/data";
import {
  createPlaceFor,
  registerReceiptFor,
  setHomeCountFor,
} from "../../src/app/(app)/vart-lager/_lib/register";
import {
  addPurchasePriceFor,
  correctPurchasePriceFor,
  loadPricePageFor,
} from "../../src/app/(app)/inkopspriser/_lib/data";
import { buyList, priceRows } from "../../src/app/(app)/_enkel/model";
import { setMysteryCostFor } from "../../src/app/(app)/vart-lager/mystery/_lib/service";

import {
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
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const session = (u: TestUser) => ({ userId: u.id, email: u.email });

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = session(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

async function setSimple(orgId: string, user: TestUser): Promise<void> {
  await db().execute(
    sql`update public.memberships set view_mode = 'simple'
        where organization_id = ${orgId}::uuid and user_id = ${user.id}::uuid`,
  );
}

/** Dagens datum i Stockholm (organisationens tidszon), som sidan skickar. */
function todayInStockholm(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

describe("Enkel vy: delägaren köper in (lager och inköpspriser)", () => {
  let owner: TestUser;
  let partner: TestUser;
  let simpleViewer: TestUser;
  let orgId: string;
  let titleId: string;
  let mysteryId: string;
  let hemma: string;

  const level = async (location: string, title = titleId) =>
    (
      await rows<{ q: number }>(
        db(),
        sql`select quantity as q from public.stock_levels
            where location_id = ${location}::uuid and title_id = ${title}::uuid`,
      )
    )[0]?.q ?? 0;

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner, "Enkel vy inköp");
    partner = await createMember(orgId, "owner");
    simpleViewer = await createMember(orgId, "viewer");
    await setSimple(orgId, partner);
    await setSimple(orgId, simpleViewer);
    const [title, mystery] = await asUser(owner, (tx) =>
      tx
        .insert(s.titles)
        .values([
          { organizationId: orgId, name: "Surging Sparks" },
          { organizationId: orgId, name: "Mystery Pack", ownProduct: true },
        ])
        .returning(),
    );
    titleId = title!.id;
    mysteryId = mystery!.id;
    hemma = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.stock_locations
            where organization_id = ${orgId}::uuid and is_central and archived_at is null`,
      )
    ).id;
  });

  it("delägaren har Enkel vy och ägarrollen", async () => {
    const v = await viewerFor(partner, orgId);
    expect(v.organization.viewMode).toBe("simple");
    expect(v.organization.role).toBe("owner");
  });

  it("Lager: delägaren rättar antalet och registrerar en leverans i Hemma", async () => {
    const v = await viewerFor(partner, orgId);
    const counted = await setHomeCountFor(v, { titleId, counted: 12 });
    expect(counted.onHand).toBe(12);
    expect(await level(hemma)).toBe(12);
    const received = await registerReceiptFor(v, { titleId, quantity: 24 });
    expect(received.previous).toBe(12);
    expect(received.onHand).toBe(36);
    expect(await level(hemma)).toBe(36);
    // Händelserna är hennes (performed_by) och loggas som vanligt.
    const events = await rows<{ kind: string; performed_by: string }>(
      db(),
      sql`select kind::text as kind, performed_by::text as performed_by from public.stock_events
          where organization_id = ${orgId}::uuid and title_id = ${titleId}::uuid
          order by seq`,
    );
    expect(events.map((e) => e.kind)).toEqual(["count", "receipt"]);
    expect(new Set(events.map((e) => e.performed_by))).toEqual(new Set([partner.id]));
  });

  it("Lager: ett andra lager (Kontoret) räknas och tar emot leveranser för sig", async () => {
    const kontoret = (await createPlaceFor(await viewerFor(owner, orgId), { name: "Kontoret" })).id;
    const v = await viewerFor(partner, orgId);
    await registerReceiptFor(v, { titleId, warehouseId: kontoret, quantity: 6 });
    await setHomeCountFor(v, { titleId, warehouseId: kontoret, counted: 5 });
    expect(await level(kontoret)).toBe(5);
    expect(await level(hemma)).toBe(36);
    // Laddaren som Lager och Inköpslistan läser: summan och per lager.
    const view = await loadVartLagerFor(v);
    const r = view.rows.find((x) => x.titleId === titleId)!;
    expect(r.home).toBe(41);
    expect(r.byPlace[hemma]).toBe(36);
    expect(r.byPlace[kontoret]).toBe(5);
    expect(view.canEdit).toBe(true);
    // Inköpslistan räknas ur samma rader (inget behov utan försäljning).
    expect(buyList(view.rows).items.some((i) => i.titleId === titleId)).toBe(false);
  });

  it("Inköpspriser: delägaren lägger in ett nytt pris från i dag och rättar det", async () => {
    const today = todayInStockholm();
    const added = await addPurchasePriceFor(session(partner), {
      organizationId: orgId,
      titleId,
      unitCostOre: 4500,
      validFrom: today,
    });
    expect(added).toMatchObject({ ok: true, data: { mode: "inserted" } });
    const corrected = await correctPurchasePriceFor(session(partner), {
      organizationId: orgId,
      titleId,
      unitCostOre: 4790,
      today,
    });
    expect(corrected.ok, corrected.ok ? "" : corrected.error).toBe(true);
    const page = await loadPricePageFor(session(partner), orgId);
    const { rows: list } = priceRows(
      [
        { id: titleId, name: "Surging Sparks" },
        { id: mysteryId, name: "Mystery Pack", ownProduct: true },
      ],
      page.prices,
      today,
    );
    expect(list.find((r) => r.titleId === titleId)?.unitCostOre).toBe(4790);
    // Ändringen loggas som hennes i audit_log (trigger), som för ägaren.
    const audit = await rows<{ actor_id: string }>(
      db(),
      sql`select actor_id::text as actor_id from public.audit_log
          where organization_id = ${orgId}::uuid and table_name = 'purchase_prices'`,
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => a.actor_id === partner.id)).toBe(true);
  });

  it("Mystery: delägaren sätter inköpspriset från innehållet", async () => {
    const v = await viewerFor(partner, orgId);
    const set = await setMysteryCostFor(v, { titleId: mysteryId, unitCostOre: 7607 });
    expect(set.unitCostOre).toBe(7607);
    const price = await one<{ unit_cost_ore: number }>(
      db(),
      sql`select unit_cost_ore from public.purchase_prices
          where organization_id = ${orgId}::uuid and title_id = ${mysteryId}::uuid`,
    );
    expect(Number(price.unit_cost_ore)).toBe(7607);
  });

  it("direkt i databasen (RLS): delägaren skriver priser och lagerhändelser", async () => {
    const price = await asUser(partner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
              values (${orgId}::uuid, ${titleId}::uuid, 5000, current_date + 30) returning id`,
        ),
      ),
    );
    expect(price.ok).toBe(true);
    const event = await asUser(partner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.stock_events
                (organization_id, location_id, title_id, kind, quantity, note)
              values (${orgId}::uuid, ${hemma}::uuid, ${titleId}::uuid, 'receipt', 1, 'RLS')
              returning id`,
        ),
      ),
    );
    expect(event.ok).toBe(true);
  });

  it("teamlåset är kvar: delägaren ändrar inte teamet (BL132)", async () => {
    const own = await one<{ id: string }>(
      db(),
      sql`select id from public.memberships
          where organization_id = ${orgId}::uuid and user_id = ${owner.id}::uuid`,
    );
    const outcome = await asUser(partner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.memberships set role = 'admin' where id = ${own.id}::uuid returning id`,
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(["BL132", "BL131"]).toContain(outcome.code);
  });

  it("en läsare med Enkel vy ser lagret och priserna men ändrar ingenting", async () => {
    const v = await viewerFor(simpleViewer, orgId);
    expect(v.organization.viewMode).toBe("simple");
    const view = await loadVartLagerFor(v);
    expect(view.canEdit).toBe(false);
    await expect(setHomeCountFor(v, { titleId, counted: 0 })).rejects.toThrow();
    await expect(registerReceiptFor(v, { titleId, quantity: 1 })).rejects.toThrow();
    const res = await addPurchasePriceFor(session(simpleViewer), {
      organizationId: orgId,
      titleId,
      unitCostOre: 1,
      validFrom: todayInStockholm(),
    });
    expect(res).toEqual({ ok: false, error: "Bara ägare och admin kan ändra inköpspriser." });
    expect(await level(hemma)).toBe(37);
  });
});
