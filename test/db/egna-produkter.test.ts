/**
 * Egna produkter: titles.own_product (förval av), "Egen produkt" i Inköpspriser
 * (setOwnProductFor) och att laddarna ger flaggan vidare.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { setOwnProductFor } from "../../src/app/(app)/inkopspriser/_lib/data";
import { PRICE_MESSAGES } from "../../src/app/(app)/inkopspriser/_lib/model";
import type { SessionUser } from "../../src/server/access";
import { queryMasterData, queryTitles } from "../../src/server/data/core/queries";
import { affected, asUser, attempt, createMember, db, rows, type TestUser } from "./helpers";
import { seedPriceFixture, type PriceFixture } from "./inkopspriser-fixture";

const su = (u: TestUser): SessionUser => ({ userId: u.id, email: u.email });

let fx: PriceFixture;
let viewer: TestUser;
let refiller: TestUser;
let admin: TestUser;
let other: PriceFixture;

async function flag(titleId: string): Promise<boolean> {
  const [r] = await rows<{ own_product: boolean }>(
    db(),
    sql`select own_product from public.titles where id = ${titleId}::uuid`,
  );
  return r!.own_product;
}

beforeAll(async () => {
  fx = await seedPriceFixture();
  viewer = await createMember(fx.orgId, "viewer");
  refiller = await createMember(fx.orgId, "refiller");
  admin = await createMember(fx.orgId, "admin");
  other = await seedPriceFixture();
});

describe("titles.own_product", () => {
  it("är av som förval, även för titlar som heter Mystery Pack", async () => {
    const [t] = await asUser(fx.owner, (tx) =>
      rows<{ id: string; own_product: boolean }>(
        tx,
        sql`insert into public.titles (organization_id, name)
            values (${fx.orgId}::uuid, 'Mystery Pack') returning id, own_product`,
      ),
    );
    expect(t!.own_product).toBe(false);
    expect(await flag(fx.titleId)).toBe(false);
  });

  it("påfyllare och läsare kan inte ändra flaggan direkt (RLS)", async () => {
    for (const u of [refiller, viewer]) {
      const n = await asUser(u, async (tx) => {
        const r = await attempt(tx, (sp) =>
          affected(
            sp,
            sql`update public.titles set own_product = true where id = ${fx.titleId}::uuid`,
          ),
        );
        return r.ok ? r.value : 0;
      });
      expect(n).toBe(0);
    }
    expect(await flag(fx.titleId)).toBe(false);
  });
});

describe("setOwnProductFor", () => {
  it("ägaren slår på och av; ändringen loggas", async () => {
    const on = await setOwnProductFor(su(fx.owner), {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      ownProduct: true,
    });
    expect(on).toEqual({ ok: true, data: { ownProduct: true } });
    expect(await flag(fx.titleId)).toBe(true);

    const log = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log
          where organization_id = ${fx.orgId}::uuid and table_name = 'titles'
            and (after ->> 'own_product')::boolean is true`,
    );
    expect(log[0]!.n).toBeGreaterThanOrEqual(1);

    const off = await setOwnProductFor(su(admin), {
      organizationId: fx.orgId,
      titleId: fx.titleId,
      ownProduct: false,
    });
    expect(off.ok).toBe(true);
    expect(await flag(fx.titleId)).toBe(false);
  });

  it("läsare, påfyllare och andra organisationer nekas", async () => {
    for (const u of [viewer, refiller, other.owner]) {
      const r = await setOwnProductFor(su(u), {
        organizationId: fx.orgId,
        titleId: fx.secondTitleId,
        ownProduct: true,
      });
      expect(r).toEqual({ ok: false, error: PRICE_MESSAGES.forbidden });
    }
    // Ägaren i en annan organisation kan inte heller nå titeln via sin egen organisation.
    const cross = await setOwnProductFor(su(other.owner), {
      organizationId: other.orgId,
      titleId: fx.secondTitleId,
      ownProduct: true,
    });
    expect(cross).toEqual({ ok: false, error: PRICE_MESSAGES.titleMissing });
    expect(await flag(fx.secondTitleId)).toBe(false);
  });

  it("sammanslagen titel och ogiltig indata avvisas", async () => {
    expect(
      await setOwnProductFor(su(fx.owner), {
        organizationId: fx.orgId,
        titleId: fx.mergedTitleId,
        ownProduct: true,
      }),
    ).toEqual({ ok: false, error: PRICE_MESSAGES.titleMerged });
    expect(
      await setOwnProductFor(su(fx.owner), {
        organizationId: fx.orgId,
        titleId: "inte-ett-id",
        ownProduct: true,
      }),
    ).toEqual({ ok: false, error: PRICE_MESSAGES.invalid });
  });

  it("laddarna ger flaggan vidare", async () => {
    await setOwnProductFor(su(fx.owner), {
      organizationId: fx.orgId,
      titleId: fx.secondTitleId,
      ownProduct: true,
    });
    const [titles, master] = await asUser(viewer, (tx) =>
      Promise.all([queryTitles(tx, fx.orgId), queryMasterData(tx, fx.orgId, "2025-06-01")]),
    );
    for (const list of [titles, master.titles]) {
      expect(list.find((t) => t.id === fx.secondTitleId)?.ownProduct).toBe(true);
      expect(list.find((t) => t.id === fx.titleId)?.ownProduct).toBe(false);
    }
  });
});
