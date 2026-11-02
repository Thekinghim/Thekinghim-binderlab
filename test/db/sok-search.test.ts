/**
 * Kommandopalettens sökning (src/server/search) mot testdatabasen: vad varje roll får
 * se, att påfyllaren aldrig får order eller belopp, isolering mellan organisationer och
 * prestanda med 100 000 order (trigramindexen i 20261102165000_sok_search_indexes.sql).
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

/** Allt användaren ser, som text: för att leta efter belopp ("kr") och ordernummer. */
function text(value: unknown): string {
  return JSON.stringify(value).replace(/ /g, " ");
}

let A: TenantFixture;
let B: TenantFixture;
let viewerUser: TestUser;
let refiller: TestUser;

beforeAll(async () => {
  A = await seedTenantFixture();
  B = await seedTenantFixture();
  viewerUser = await createMember(A.orgId, "viewer");
  refiller = await createMember(A.orgId, "refiller");
});

describe("sökning per roll", () => {
  it("ägaren hittar ordern på ordernummer, med automat, tid och belopp", async () => {
    const res = await searchFor(await viewerFor(A.owner, A.orgId), "42001", NOW);
    expect(res.groups[0]?.kind).toBe("order");
    const hit = res.groups[0]!.hits[0]!;
    expect(hit).toMatchObject({ code: "42001", label: "Pokémon 151 Booster" });
    expect(text(hit.meta)).toBe(text(["BL-001", "10 mars 11:00", "79 kr"]));
    expect(hit.href).toContain(`order=${A.orderIds[0]}`);
  });

  it("läsaren ser order och belopp; titel och automat ger träffar i alla grupper", async () => {
    const res = await searchFor(await viewerFor(viewerUser, A.orgId), "surging", NOW);
    expect(res.groups.map((g) => g.kind)).toEqual(["title", "order"]);
    expect(text(res)).toContain("89 kr");
    const machine = await searchFor(await viewerFor(viewerUser, A.orgId), "bl-001", NOW);
    expect(machine.groups.map((g) => g.kind)).toEqual(["machine", "order"]);
  });

  it("titeln hittas på alias (originalstavning från källan)", async () => {
    const res = await searchFor(await viewerFor(A.owner, A.orgId), "pokemon 151", NOW);
    const titles = res.groups.find((g) => g.kind === "title")!;
    expect(titles.hits.map((h) => h.label)).toEqual(["Pokémon 151 Booster"]);
  });

  it("påfyllaren ser inga belopp och inga order", async () => {
    const v = await viewerFor(refiller, A.orgId);
    for (const q of ["42001", "pokemon", "surging", "bl-001", "ica", "79"]) {
      const res = await searchFor(v, q, NOW);
      expect(
        res.groups.map((g) => g.kind),
        q,
      ).not.toContain("order");
      expect(text(res.groups), q).not.toMatch(/\bkr\b|\böre\b|42001|42002/);
    }
    const res = await searchFor(v, "pokemon", NOW);
    expect(res.groups[0]!.hits[0]).toMatchObject({ step: "refill-machine", carry: "none" });
    expect(res.groups[0]!.hits[0]!.href).toBeUndefined();
  });

  it("påfyllaren: titlar för påfyllning i antal pack, inget inköpspris", async () => {
    const v = await viewerFor(refiller, A.orgId);
    const list = await pickListFor(v, "pafyllning", A.machineId, NOW);
    expect(list.groups[0]!.label).toBe("I automaten");
    // Minst kvar först; antal pack (försäljningen har dragit av från påfyllningen).
    const items = list.groups[0]!.items;
    expect(items.map((i) => i.label)).toEqual(["Surging Sparks Booster", "Pokémon 151 Booster"]);
    for (const i of items) expect(text(i.meta)).toMatch(/^\["\d+ st kvar"\]$/);
    expect(text(list)).not.toMatch(/\bkr\b/);
    await expect(pickListFor(v, "inkopspris", null, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("läsaren får inte listan för nytt inköpspris; ägaren får den", async () => {
    await expect(
      pickListFor(await viewerFor(viewerUser, A.orgId), "inkopspris", null, NOW),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const list = await pickListFor(await viewerFor(A.owner, A.orgId), "inkopspris", null, NOW);
    expect(list.groups.map((g) => g.label)).toEqual(["Med inköpspris"]);
  });

  it("påfyllaren når inte order ens med SQL (RLS)", async () => {
    const visible = await asUser(refiller, (tx) =>
      rows(tx, sql`select id from public.orders where organization_id = ${A.orgId}::uuid`),
    );
    expect(visible).toHaveLength(0);
  });
});

describe("isolering", () => {
  it("B:s ägare hittar inte A:s order, titlar eller automater", async () => {
    const res = await searchFor(await viewerFor(B.owner, B.orgId), "42001", NOW);
    expect(text(res)).not.toContain(A.orderIds[0]!);
    const titles = await searchFor(await viewerFor(B.owner, B.orgId), "surging", NOW);
    expect(text(titles)).not.toContain(A.orgId);
    for (const g of titles.groups)
      for (const h of g.hits) expect(text(h)).not.toContain(A.machineId);
  });

  it("en användare utan medlemskap i organisationen stoppas", async () => {
    const forged: Viewer = {
      user: { userId: B.owner.id, email: B.owner.email },
      organization: {
        id: A.orgId,
        name: "A",
        slug: "a",
        timezone: "Europe/Stockholm",
        role: "owner",
      },
    };
    await expect(searchFor(forged, "42001", NOW)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(pickListFor(forged, "pafyllning", A.machineId, NOW)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe("prestanda med 100 000 order", () => {
  const BULK = 100_000;
  const TITLES = [
    "Ascended Heroes",
    "Mystery Pack",
    "30th Celebration",
    "Black Bolt",
    "White Flare",
    "Prismatic Evolutions",
    "Journey Together",
    "Destined Rivals",
  ];

  beforeAll(async () => {
    // Som databasägare (utan RLS) för fart; datan hör till A. B får 20 000, så att
    // indexen innehåller en annan organisations rader också.
    for (const [org, count] of [
      [A, BULK],
      [B, 20_000],
    ] as const) {
      await asPostgres((tx) =>
        tx.execute(
          sql`insert into public.orders
                (organization_id, data_source_id, external_id, raw_title, title_id, machine_id,
                 ordered_at, amount_ore, source_hash)
              select ${org.orgId}::uuid, ${org.dataSourceId}::uuid, (100000 + g)::text,
                     (${`{${TITLES.map((t) => `"${t}"`).join(",")}}`}::text[])[1 + g % ${TITLES.length}],
                     case when g % 2 = 0 then ${org.titleId}::uuid end,
                     ${org.machineId}::uuid,
                     '2024-01-01T08:00:00Z'::timestamptz + g * interval '7 minutes',
                     7900 + (g % 5) * 1000, ${`bulk-${randomUUID()}-`} || g
              from generate_series(1, ${count}) g`,
        ),
      );
    }
    await db().execute(sql`analyze public.orders`);
  }, 120_000);

  const QUERIES = [
    "142780", // exakt ordernummer
    "14278", // del av ordernummer
    "zzqx", // ingen träff (måste inte läsa alla order)
    "destined", // vanlig originaltitel
    "pokemon", // titel via alias → title_id
    "bl-001 mystery", // två ord: automat och originaltitel
    "999999", // ordernummer som inte finns
  ];

  it("varje sökning tar under 150 ms (median under 40 ms) som ägaren", async () => {
    const v = await viewerFor(A.owner, A.orgId);
    // Uppvärmning: anslutning och planer.
    await searchFor(v, "uppvärmning", NOW);
    const timings: Record<string, number> = {};
    for (const q of QUERIES) {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const res = await searchFor(v, q, NOW);
        runs.push(performance.now() - t0);
        if (q === "142780") expect(res.groups[0]!.hits[0]!.code).toBe("142780");
        if (q === "zzqx" || q === "999999") {
          expect(res.groups.filter((g) => g.kind === "order")).toEqual([]);
        }
      }
      runs.sort((a, b) => a - b);
      timings[q] = Math.round(runs[2]! * 10) / 10;
      expect(runs[4]!, `"${q}": ${runs.map((r) => r.toFixed(1)).join(", ")} ms`).toBeLessThan(150);
    }
    const medians = Object.values(timings).sort((a, b) => a - b);
    console.info("[sok] median per sökning (ms):", timings);
    expect(medians[Math.floor(medians.length / 2)]!).toBeLessThan(40);
  }, 60_000);

  it("ovanliga sökord använder trigramindexet i stället för att läsa alla order", async () => {
    // Samma fråga som private.search_orders kör (ett organisationsvillkor, utan RLS).
    // Under RLS skulle planeraren välja ett btree-index på organization_id och läsa
    // alla organisationens order; därför går sökningen via funktionen.
    const plan = await asPostgres((tx) =>
      rows<{ "QUERY PLAN": string }>(
        tx,
        sql`explain select o.id from public.orders o
            where o.organization_id = ${A.orgId}::uuid
              and (o.external_id ilike '%zzqx%' or o.raw_title ilike '%zzqx%')
            order by o.ordered_at desc, o.id desc limit 6`,
      ),
    );
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toContain("orders_external_id_trgm_idx");
    expect(text).toContain("orders_raw_title_trgm_idx");
  });

  it("search_orders släpper inte igenom påfyllaren eller en annan organisation", async () => {
    const terms = JSON.stringify([{ pattern: "%142%", title_ids: [], machine_ids: [] }]);
    for (const [user, orgId] of [
      [refiller, A.orgId],
      [B.owner, A.orgId],
    ] as const) {
      const outcome = await asUser(user, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`select * from private.search_orders(${orgId}::uuid, ${terms}::jsonb, null, 6)`,
          ),
        ),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe("42501");
    }
  });

  it("search_orders gör sökorden till literaler (ingen SQL från anroparen)", async () => {
    const evil = JSON.stringify([
      { pattern: "%') or true or ('%", title_ids: [], machine_ids: [] },
    ]);
    const result = await asUser(A.owner, (tx) =>
      rows(tx, sql`select * from private.search_orders(${A.orgId}::uuid, ${evil}::jsonb, null, 6)`),
    );
    expect(result).toHaveLength(0);
    const badIds = JSON.stringify([{ pattern: "%a%", title_ids: ["x'); drop table x; --"] }]);
    const outcome = await asUser(A.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select * from private.search_orders(${A.orgId}::uuid, ${badIds}::jsonb, null, 6)`,
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("22P02");
  });

  it("påfyllaren söker lika snabbt (ingen ordersökning)", async () => {
    const v = await viewerFor(refiller, A.orgId);
    await searchFor(v, "uppvärmning", NOW);
    const t0 = performance.now();
    const res = await searchFor(v, "destined", NOW);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(res.groups.map((g) => g.kind)).not.toContain("order");
  });
});
