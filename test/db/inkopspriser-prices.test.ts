/**
 * Inköpspriser mot testdatabasen: laddarna och flödet bakom server action "nytt pris".
 *
 * Fixturen har priser från 1 jan. 2025 och december 2024 är stängd.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  addPurchasePriceFor,
  loadPricePageFor,
  loadTitleDetailFor,
} from "../../src/app/(app)/inkopspriser/_lib/data";
import { PRICE_MESSAGES, priceLog } from "../../src/app/(app)/inkopspriser/_lib/model";
import { AuthorizationError, type SessionUser } from "../../src/server/access";
import { createMember, db, rows, type TestUser } from "./helpers";
import { seedPriceFixture, type PriceFixture } from "./inkopspriser-fixture";

const su = (u: TestUser): SessionUser => ({ userId: u.id, email: u.email });

let fx: PriceFixture;
let owner: SessionUser;
let admin: SessionUser;
let viewer: SessionUser;
let refiller: SessionUser;
let otherOwner: SessionUser;
let otherOrgId: string;

beforeAll(async () => {
  fx = await seedPriceFixture();
  owner = su(fx.owner);
  admin = su(await createMember(fx.orgId, "admin"));
  viewer = su(await createMember(fx.orgId, "viewer"));
  refiller = su(await createMember(fx.orgId, "refiller"));
  const other = await seedPriceFixture();
  otherOwner = su(other.owner);
  otherOrgId = other.orgId;
});

describe("loadPricePageFor och loadTitleDetailFor", () => {
  it("ägare och läsare ser priser, stängda månader och orderdagar", async () => {
    for (const u of [owner, viewer]) {
      const page = await loadPricePageFor(u, fx.orgId);
      expect(page.prices.some((p) => p.titleId === fx.titleId && p.unitCostOre === 4500)).toBe(
        true,
      );
      expect(page.closedMonths).toContain("2024-12");
      const detail = await loadTitleDetailFor(u, fx.orgId, fx.titleId);
      expect(
        detail.events.some((e) => e.action === "insert" && e.after?.unitCostOre === 4500),
      ).toBe(true);
      expect(detail.orderDays.reduce((n, d) => n + d.orders, 0)).toBeGreaterThan(0);
    }
  });

  it("påfyllaren och andra organisationer släpps inte in", async () => {
    await expect(loadPricePageFor(refiller, fx.orgId)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(loadTitleDetailFor(refiller, fx.orgId, fx.titleId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(loadPricePageFor(otherOwner, fx.orgId)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("senaste prisändringen kommer från ändringsloggen", async () => {
    const page = await loadPricePageFor(viewer, fx.orgId);
    const last = await rows(
      db(),
      sql`select max(occurred_at) as at from public.audit_log
          where organization_id = ${fx.orgId} and table_name = 'purchase_prices'`,
    );
    expect(page.lastChangeAt).not.toBeNull();
    expect(new Date(page.lastChangeAt!).getTime()).toBe(new Date(String(last[0]?.at)).getTime());
  });

  it("ett ogiltigt titel-id ger tomt underlag, inte ett fel", async () => {
    expect(await loadTitleDetailFor(owner, fx.orgId, "inte-ett-id")).toEqual({
      events: [],
      orderDays: [],
    });
  });
});

describe("addPurchasePriceFor", () => {
  it("ägaren lägger till ett pris; det loggas med vem, före och efter", async () => {
    const r = await addPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 4_800,
      validFrom: "2025-03-01",
      note: "Ny leverantör",
    });
    expect(r).toMatchObject({ ok: true, data: { mode: "inserted" } });

    const stored = await rows(
      db(),
      sql`select unit_cost_ore::int as unit_cost_ore, note, created_by from public.purchase_prices
          where organization_id = ${fx.orgId} and title_id = ${fx.titleId} and valid_from = '2025-03-01'`,
    );
    expect(stored).toEqual([
      { unit_cost_ore: 4800, note: "Ny leverantör", created_by: owner.userId },
    ]);

    const detail = await loadTitleDetailFor(owner, fx.orgId, fx.titleId);
    const log = priceLog(detail.events, { [owner.userId]: "Ägaren" });
    expect(log[0]).toMatchObject({
      kind: "Nytt pris",
      actor: "Ägaren",
      validFrom: "2025-03-01",
      beforeOre: 4_500,
      afterOre: 4_800,
      note: "Ny leverantör",
    });
  });

  it("samma datum ändrar det befintliga priset; samma värde igen avvisas", async () => {
    const r = await addPurchasePriceFor(admin, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 4_900,
      validFrom: "2025-03-01",
      note: "Ny leverantör",
    });
    expect(r).toMatchObject({ ok: true, data: { mode: "replaced" } });
    const again = await addPurchasePriceFor(admin, {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 4_900,
      validFrom: "2025-03-01",
      note: "Ny leverantör",
    });
    expect(again).toEqual({ ok: false, error: PRICE_MESSAGES.unchanged });

    const detail = await loadTitleDetailFor(viewer, fx.orgId, fx.titleId);
    const updates = detail.events.filter((e) => e.action === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      actorId: admin.userId,
      before: { unitCostOre: 4_800 },
      after: { unitCostOre: 4_900 },
    });
  });

  it("blockeras i en stängd månad med ett begripligt fel", async () => {
    const inClosed = await addPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.secondTitleId,
      unitCostOre: 5_000,
      validFrom: "2024-12-15",
    });
    expect(inClosed).toEqual({ ok: false, error: PRICE_MESSAGES.closedMonth(["2024-12"]) });
    expect(inClosed.error).toContain("december 2024");

    // Ett pris i en öppen månad som skulle gälla in i den stängda (nästa pris är 1 jan. 2025).
    const intoClosed = await addPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.secondTitleId,
      unitCostOre: 5_000,
      validFrom: "2024-11-20",
    });
    expect(intoClosed.ok).toBe(false);
    expect(intoClosed.error).toContain("december 2024");

    const count = await rows(
      db(),
      sql`select count(*)::int as n from public.purchase_prices
          where organization_id = ${fx.orgId} and title_id = ${fx.secondTitleId}`,
    );
    expect(count[0]?.n).toBe(1);
  });

  it("en ren ändring av anteckningen på ett pris i en stängd månad släpps igenom", async () => {
    const base = { organizationId: fx.orgId, titleId: fx.closedTitleId, validFrom: "2024-11-01" };
    const changedAmount = await addPurchasePriceFor(owner, { ...base, unitCostOre: 6_100 });
    expect(changedAmount).toEqual({
      ok: false,
      error: PRICE_MESSAGES.closedMonth(["2024-12"]),
    });
    const noteOnly = await addPurchasePriceFor(owner, {
      ...base,
      unitCostOre: 6_000,
      note: "Faktura 1182",
    });
    expect(noteOnly).toMatchObject({ ok: true, data: { mode: "replaced" } });
    const stored = await rows(
      db(),
      sql`select unit_cost_ore::int as unit_cost_ore, note from public.purchase_prices
          where organization_id = ${fx.orgId} and title_id = ${fx.closedTitleId}`,
    );
    expect(stored).toEqual([{ unit_cost_ore: 6_000, note: "Faktura 1182" }]);
  });

  it("läsare, påfyllare och andra organisationers ägare får inte lägga till", async () => {
    const input = {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      unitCostOre: 1,
      validFrom: "2025-05-01",
    };
    for (const u of [viewer, refiller, otherOwner]) {
      expect(await addPurchasePriceFor(u, input)).toEqual({
        ok: false,
        error: PRICE_MESSAGES.forbidden,
      });
    }
    expect(await addPurchasePriceFor(null, input)).toEqual({
      ok: false,
      error: "Du är inte inloggad.",
    });
    // En annan organisations ägare kan inte heller nå titeln via sin egen organisation.
    expect(await addPurchasePriceFor(otherOwner, { ...input, organizationId: otherOrgId })).toEqual(
      {
        ok: false,
        error: PRICE_MESSAGES.titleMissing,
      },
    );
  });

  it("ogiltig indata avvisas innan något händer", async () => {
    const base = { organizationId: fx.orgId, titleId: fx.titleId, validFrom: "2025-06-01" };
    for (const bad of [
      { ...base, unitCostOre: -1 },
      { ...base, unitCostOre: 1.5 },
      { ...base, unitCostOre: 100, validFrom: "2025-02-30" },
      { ...base, unitCostOre: 100, titleId: "x" },
    ]) {
      expect(await addPurchasePriceFor(owner, bad)).toEqual({
        ok: false,
        error: PRICE_MESSAGES.invalid,
      });
    }
  });

  it("en sammanslagen titel tar inte emot priser", async () => {
    const r = await addPurchasePriceFor(owner, {
      organizationId: fx.orgId,
      titleId: fx.mergedTitleId,
      unitCostOre: 100,
      validFrom: "2025-06-01",
    });
    expect(r).toEqual({ ok: false, error: PRICE_MESSAGES.titleMerged });
  });
});
