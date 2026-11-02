/**
 * Oberoende granskning av kommandopalettens sökning (src/server/search, GET /sok,
 * private.search_orders). Letar efter läckor mellan roller och organisationer och
 * efter sökningar som blir långsamma med 100 000 order.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, listOrganizationsFor, type SessionUser } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { pickListFor, searchFor } from "@/server/search/service";

import {
  asPostgres,
  asUser,
  attempt,
  createMember,
  createUser,
  db,
  rows,
  seedTenantFixture,
  type TenantFixture,
  type TestUser,
} from "./helpers";

const NOW = new Date("2025-04-02T09:00:00Z");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

function forged(u: TestUser, orgId: string, role: "owner" | "refiller" = "owner"): Viewer {
  return {
    user: { userId: u.id, email: u.email },
    organization: { id: orgId, name: "x", slug: "x", timezone: "Europe/Stockholm", role },
  };
}

let A: TenantFixture;
let B: TenantFixture;
let storeUser: TestUser;

beforeAll(async () => {
  A = await seedTenantFixture();
  B = await seedTenantFixture();
  storeUser = await createUser(`store-rt-${randomUUID().slice(0, 8)}@test.binderlab.se`);
  await asPostgres((tx) =>
    tx.execute(
      sql`insert into public.memberships (organization_id, user_id, role, store_id)
          values (${A.orgId}::uuid, ${storeUser.id}::uuid, 'store', ${A.storeId}::uuid)`,
    ),
  );
});

describe("roller och isolering", () => {
  it("butiksanvändaren (store) stoppas i tjänsten och i search_orders", async () => {
    await expect(searchFor(forged(storeUser, A.orgId), "42001", NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      pickListFor(forged(storeUser, A.orgId), "pafyllning", A.machineId, NOW),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const terms = JSON.stringify([{ pattern: "%4%", title_ids: [], machine_ids: [] }]);
    const outcome = await asUser(storeUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select * from private.search_orders(${A.orgId}::uuid, ${terms}::jsonb,
                       '42001', 6)`),
      ),
    );
    expect(outcome.code).toBe("42501");
  });

  it("anon och utan inloggning når inte search_orders", async () => {
    const terms = JSON.stringify([{ pattern: "%4%", title_ids: [], machine_ids: [] }]);
    const outcome = await asPostgres(async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
      await tx.execute(sql`set local role anon`);
      return attempt(tx, (sp) =>
        sp.execute(
          sql`select * from private.search_orders(${A.orgId}::uuid, ${terms}::jsonb, null, 6)`,
        ),
      );
    });
    expect(outcome.ok).toBe(false);
  });

  it("A:s ägare kan inte smuggla in B:s titel- eller automat-id och få B:s order", async () => {
    const terms = JSON.stringify([
      { pattern: "%zzzz%", title_ids: [B.titleId], machine_ids: [B.machineId] },
    ]);
    const res = await asUser(A.owner, (tx) =>
      rows(
        tx,
        sql`select * from private.search_orders(${A.orgId}::uuid, ${terms}::jsonb, null, 6)`,
      ),
    );
    expect(res).toHaveLength(0);
  });

  it("nedgraderad ägare (till påfyllare) får inga order direkt efter bytet", async () => {
    const u = await createMember(A.orgId, "admin");
    const v = await viewerFor(u, A.orgId);
    expect((await searchFor(v, "42001", NOW)).groups.map((g) => g.kind)).toContain("order");
    await asPostgres((tx) =>
      tx.execute(sql`update public.memberships set role = 'refiller'
                     where organization_id = ${A.orgId}::uuid and user_id = ${u.id}::uuid`),
    );
    // Viewer har kvar rollen "admin" i sin organisation: tjänsten måste läsa om rollen.
    const res = await searchFor(v, "42001", NOW);
    expect(res.groups.map((g) => g.kind)).not.toContain("order");
    expect(JSON.stringify(res)).not.toMatch(/\bkr\b/);
  });

  it("borttagen medlem stoppas", async () => {
    const u = await createMember(A.orgId, "viewer");
    const v = await viewerFor(u, A.orgId);
    await asPostgres((tx) =>
      tx.execute(sql`delete from public.memberships
                     where organization_id = ${A.orgId}::uuid and user_id = ${u.id}::uuid`),
    );
    await expect(searchFor(v, "42001", NOW)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("påfyllarens plocklista för B:s automat ger inget", async () => {
    const r = await createMember(A.orgId, "refiller");
    const list = await pickListFor(await viewerFor(r, A.orgId), "pafyllning", B.machineId, NOW);
    expect(list.groups).toEqual([]);
  });

  it("LIKE-tecken i söktexten tolkas bokstavligt", async () => {
    const v = await viewerFor(A.owner, A.orgId);
    for (const q of ["%%%", "___", "\\\\\\", "%_%"]) {
      const res = await searchFor(v, q, NOW);
      expect(
        res.groups.map((g) => g.kind),
        q,
      ).not.toContain("order");
    }
  });
});

describe("prestanda: mönster som funktionens egna test inte täcker", () => {
  const TITLES = ["Ascended Heroes", "Mystery Pack", "30th Celebration", "Destined Rivals"];
  let v: Viewer;

  beforeAll(async () => {
    await asPostgres((tx) =>
      tx.execute(
        sql`insert into public.orders
              (organization_id, data_source_id, external_id, raw_title, title_id, machine_id,
               ordered_at, amount_ore, source_hash)
            select ${A.orgId}::uuid, ${A.dataSourceId}::uuid, (100000 + g)::text,
                   case when g <= 1500 then 'Legacy Vintage Box'
                        else (${`{${TITLES.map((t) => `"${t}"`).join(",")}}`}::text[])[1 + g % 4] end,
                   case when g % 2 = 0 then ${A.titleId}::uuid end,
                   ${A.machineId}::uuid,
                   '2023-01-01T08:00:00Z'::timestamptz + g * interval '7 minutes',
                   7900, ${`rt-${randomUUID()}-`} || g
            from generate_series(1, 100000) g`,
      ),
    );
    await db().execute(sql`analyze public.orders`);
    v = await viewerFor(A.owner, A.orgId);
    await searchFor(v, "uppvärmning", NOW);
  }, 180_000);

  const CASES = [
    "vintage", // 1,5 % av ordern, alla äldst: ordered_at-index går igenom nästan allt?
    "legacy box", // samma, två ord
    "zzqx e", // ovanligt ord + ord på ett tecken (trigram kan inte användas för "e")
    "asc e", // vanligt ord + ett tecken
    "vintage a", // gammalt ord + ett tecken
    "zzq zzw zzr zzt zzy zzu", // sex ovanliga ord
    "booster zzqx", // titelalias som ger title_id = any(...) + ovanligt ord
    "1000", // ordernummer-liknande (exakt + delsträng)
    "100", // tre siffror: 1 000+ träffar på delsträng
  ];

  // Sökord utan bokstäver och siffror har inga trigram: trigramindexet kan inte
  // användas och Postgres läser varje order i organisationen (Rows Removed by
  // Filter: 100000). Tre tecken räcker för MIN_ORDER_TERM, så "---" söker i order.
  for (const q of ["---", "%_%_%", "..."]) {
    it(`"${q}" (inga trigram) läser inte alla order: under 40 ms`, async () => {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await searchFor(v, q, NOW);
        runs.push(performance.now() - t0);
      }
      runs.sort((a, b) => a - b);
      console.info(`[redteam-sok] "${q}": ${runs.map((r) => r.toFixed(1)).join(", ")} ms`);
      expect(runs[2]!).toBeLessThan(40);
    }, 60_000);
  }

  for (const q of CASES) {
    it(`"${q}" under 150 ms`, async () => {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await searchFor(v, q, NOW);
        runs.push(performance.now() - t0);
      }
      runs.sort((a, b) => a - b);
      console.info(`[redteam-sok] "${q}": ${runs.map((r) => r.toFixed(1)).join(", ")} ms`);
      expect(runs[2]!).toBeLessThan(150);
    }, 60_000);
  }
});
