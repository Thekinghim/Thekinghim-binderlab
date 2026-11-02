/**
 * Sammanslagning av titlar: order flyttas (loggas), försäljningshändelserna
 * följer med via det kontrollerade undantaget i append-only-regeln, övrigt
 * lager flyttas med kompenserande händelser, och totalsaldot är oförändrat.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "../../src/db/schema";
import {
  asPostgres,
  asUser,
  attempt,
  createMember,
  db,
  one,
  rows,
  seedTenantFixture,
  type TenantFixture,
} from "./helpers";

let F: TenantFixture;
let levelsBefore: Map<string, number>;
let moved: number;

async function levelsByLocation(orgId: string, titles: string[]): Promise<Map<string, number>> {
  const result = await rows<{ location_id: string; total: number }>(
    db(),
    sql`select location_id, sum(quantity)::int as total from public.stock_levels
        where organization_id = ${orgId} and title_id in (${sql.join(
          titles.map((t) => sql`${t}`),
          sql`, `,
        )})
        group by location_id`,
  );
  return new Map(result.map((r) => [r.location_id, r.total]));
}

beforeAll(async () => {
  F = await seedTenantFixture();
  levelsBefore = await levelsByLocation(F.orgId, [F.titleId, F.secondTitleId]);
  moved = (
    await asUser(F.owner, (tx) =>
      one<{ moved: number }>(
        tx,
        sql`select public.merge_titles(${F.orgId}, ${F.secondTitleId}, ${F.titleId}) as moved`,
      ),
    )
  ).moved;
});

describe("merge_titles", () => {
  it("flyttar orderna men skriver inte om raw_title eller alias", async () => {
    expect(moved).toBe(1);
    const orders = await rows<{ title_id: string; raw_title: string }>(
      db(),
      sql`select title_id, raw_title from public.orders where organization_id = ${F.orgId} order by external_id`,
    );
    expect(orders.every((o) => o.title_id === F.titleId)).toBe(true);
    expect(orders.map((o) => o.raw_title)).toEqual(["Pokemon 151", "Surging Sparks"]);
    const alias = await one<{ title_id: string }>(
      db(),
      sql`select title_id from public.title_aliases where organization_id = ${F.orgId} and alias = 'Pokemon 151'`,
    );
    expect(alias.title_id).toBe(F.titleId);
  });

  it("försäljningshändelserna följer med ordern", async () => {
    const events = await rows<{ title_id: string }>(
      db(),
      sql`select e.title_id from public.stock_events e
          join public.orders o on o.organization_id = e.organization_id and o.id = e.order_id
          where o.organization_id = ${F.orgId}`,
    );
    expect(events.length).toBe(2);
    expect(events.every((e) => e.title_id === F.titleId)).toBe(true);
  });

  it("totalsaldot per lagerplats är oförändrat och den gamla titeln är tom", async () => {
    expect(await levelsByLocation(F.orgId, [F.titleId, F.secondTitleId])).toEqual(levelsBefore);
    const old = await rows<{ quantity: number }>(
      db(),
      sql`select quantity from public.stock_levels where organization_id = ${F.orgId} and title_id = ${F.secondTitleId}`,
    );
    expect(old.every((l) => l.quantity === 0)).toBe(true);
    const merged = await rows<{ location_id: string; quantity: number }>(
      db(),
      sql`select location_id, quantity from public.stock_levels where organization_id = ${F.orgId} and title_id = ${F.titleId}`,
    );
    expect(Object.fromEntries(merged.map((m) => [m.location_id, m.quantity]))).toEqual({
      [F.machineLocationId]: 13,
      [F.centralLocationId]: 31,
    });
  });

  it("den gamla titeln pekar på den nya och är arkiverad", async () => {
    const title = await one<{ merged_into_id: string; archived_at: Date | null }>(
      db(),
      sql`select merged_into_id, archived_at from public.titles where id = ${F.secondTitleId}`,
    );
    expect(title.merged_into_id).toBe(F.titleId);
    expect(title.archived_at).not.toBeNull();
  });

  it("allt loggas i audit_log med aktör", async () => {
    const log = await rows<{
      table_name: string;
      actor_id: string;
      before: { title_id?: string };
      after: { title_id?: string };
    }>(
      db(),
      sql`select table_name, actor_id, before, after from public.audit_log
          where organization_id = ${F.orgId} and action = 'update'
            and table_name in ('orders', 'stock_events', 'titles')
            and occurred_at >= (select max(occurred_at) - interval '1 minute' from public.audit_log where organization_id = ${F.orgId})`,
    );
    const tablesLogged = new Set(log.map((l) => l.table_name));
    expect(tablesLogged).toEqual(new Set(["orders", "stock_events", "titles"]));
    expect(log.every((l) => l.actor_id === F.owner.id)).toBe(true);
    const saleMove = log.find((l) => l.table_name === "stock_events");
    expect(saleMove?.before.title_id).toBe(F.secondTitleId);
    expect(saleMove?.after.title_id).toBe(F.titleId);
  });

  it("en sale-händelse kan inte flyttas direkt, inte ens av databasägaren", async () => {
    const outcome = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.stock_events set title_id = ${F.secondTitleId}
                       where organization_id = ${F.orgId} and kind = 'sale'`),
      ),
    );
    expect(outcome.code).toBe("BL002");
  });

  it("nekas för påfyllare, för en redan sammanslagen titel och för samma titel", async () => {
    const refiller = await createMember(F.orgId, "refiller");
    const call = (user: typeof F.owner, from: string, into: string) =>
      asUser(user, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`select public.merge_titles(${F.orgId}, ${from}, ${into})`),
        ),
      );
    const [third] = await asUser(F.owner, (tx) =>
      tx.insert(s.titles).values({ organizationId: F.orgId, name: "Tredje titeln" }).returning(),
    );
    expect((await call(refiller, third!.id, F.titleId)).code).toBe("42501");
    expect((await call(F.owner, F.secondTitleId, F.titleId)).code).toBe("22023");
    expect((await call(F.owner, third!.id, F.secondTitleId)).code).toBe("22023");
    expect((await call(F.owner, F.titleId, F.titleId)).code).toBe("22023");
  });

  it("merged_into_id kan inte sättas direkt", async () => {
    const outcome = await asUser(F.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.titles set merged_into_id = ${F.titleId} where id = ${F.secondTitleId}`,
        ),
      ),
    );
    expect(outcome.code).toBe("42501");
  });
});
