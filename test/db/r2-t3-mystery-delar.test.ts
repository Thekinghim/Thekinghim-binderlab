/**
 * Runda 2, T3-5 (inköpslistan räknar med delarna som mystery packs äter upp), mot
 * testdatabasen och genom de riktiga laddarna (RLS som användaren).
 *
 * - Mystery Pack säljer i en automat; innehållet har 4 Pokémon 151, 9 Paldea och 1 träff per
 *   omgång (14). Planens omgångar × innehållet läggs på delarnas behov.
 * - Pokémon 151 säljer också själv: antalet att köpa = egen försäljning + delen till
 *   mystery packet, och raden säger hur många som går dit, samma på Vårt lager och Inköp.
 * - Paldea och träffen säljs inte själva men ska ändå köpas.
 * - Det som ligger hemma av en del dras av; färdiga mystery packs sänker omgångarna.
 * - Läsaren ser samma plan (innehållet har inga belopp); påfyllaren får inte läsa planen.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { mysteryBatchesToPack } from "../../src/domain";
import { purchaseQty } from "../../src/analytics/purchasing";
import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";
import { loadPrognosFor, loadPurchasePlanFor } from "../../src/server/purchasing";
import { buildPageModel } from "../../src/app/(app)/prognos/_lib/model";
import { buyList } from "../../src/app/(app)/_enkel/model";
import { loadVartLagerFor } from "../../src/app/(app)/vart-lager/_lib/data";

import { asUser, createMember, createOrg, createUser, db, one, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

describe("Inköpslistan räknar med delarna som mystery packs äter upp", () => {
  let owner: TestUser;
  let reader: TestUser;
  let refiller: TestUser;
  let orgId: string;
  let hemma: string;
  let mp: string;
  let p151: string;
  let paldea: string;
  let hit: string;

  const plan = async (u: TestUser) => loadPurchasePlanFor(await viewerFor(u, orgId));
  const qty = (p: Awaited<ReturnType<typeof plan>>, titleId: string) => {
    const line = p.lines.find((l) => l.titleId === titleId);
    return line ? purchaseQty(line) : 0;
  };
  const count = (titleId: string, quantity: number) =>
    asUser(owner, (tx) =>
      tx.insert(s.stockEvents).values({
        organizationId: orgId,
        locationId: hemma,
        titleId,
        kind: "count",
        quantity,
      }),
    );

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner, "Delar i mystery packs");
    reader = await createMember(orgId, "viewer");
    refiller = await createMember(orgId, "refiller");
    await asUser(owner, async (tx) => {
      const org = { organizationId: orgId };
      const titles = await tx
        .insert(s.titles)
        .values([
          { ...org, name: "Mystery Pack", ownProduct: true },
          { ...org, name: "Pokémon 151" },
          { ...org, name: "Paldea" },
          { ...org, name: "Träffen" },
        ])
        .returning();
      [mp, p151, paldea, hit] = titles.map((t) => t.id) as [string, string, string, string];
      const [machine] = await tx
        .insert(s.machines)
        .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2026-01-01" })
        .returning();
      const [source] = await tx
        .insert(s.dataSources)
        .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
        .returning();
      // 40 dagar t.o.m. i går: Mystery Pack 2 om dagen, Pokémon 151 1 om dagen.
      const day = 24 * 60 * 60 * 1000;
      const values = [];
      for (let d = 1; d <= 40; d += 1) {
        for (const [titleId, name, n] of [
          [mp, "Mystery Pack", 2],
          [p151, "Pokémon 151", 1],
        ] as const) {
          for (let k = 0; k < n; k += 1) {
            values.push({
              ...org,
              dataSourceId: source!.id,
              externalId: `md-${name}-${d}-${k}`,
              rawTitle: name,
              titleId,
              machineId: machine!.id,
              orderedAt: new Date(Date.now() - d * day + k * 60_000),
              amountOre: 14_900,
              sourceHash: `md-${name}-${d}-${k}`,
            });
          }
        }
      }
      await tx.insert(s.orders).values(values);
    });
    hemma = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.stock_locations
            where organization_id = ${orgId}::uuid and is_central and archived_at is null`,
      )
    ).id;
  });

  /** Omgångarna som delarna köps för (det största av planens och fackens antal). */
  const partBatches = (p: Awaited<ReturnType<typeof plan>>): number =>
    p.lines.find((l) => l.titleId === hit)?.mysteryNeed?.parts[0]?.batches ?? 0;

  it("utan innehåll: delarna räknas bara på sin egen försäljning", async () => {
    const p = await plan(owner);
    expect(qty(p, mp)).toBeGreaterThan(0);
    expect(qty(p, p151)).toBeGreaterThan(0);
    expect(qty(p, paldea)).toBe(0);
    expect(p.lines.some((l) => l.mysteryNeed)).toBe(false);
  });

  it("med innehåll: omgångarna × innehållet läggs på varje del", async () => {
    const before = await plan(owner);
    const own151 = qty(before, p151);
    await asUser(owner, (tx) =>
      tx.execute(
        sql`select public.save_mystery_recipe(${orgId}::uuid, ${mp}::uuid, 14, ${JSON.stringify([
          { titleId: p151, quantity: 4, hit: false },
          { titleId: paldea, quantity: 9, hit: false },
          { titleId: hit, quantity: 1, hit: true },
        ])}::jsonb)`,
      ),
    );
    const p = await plan(owner);
    // Raden för mystery packet: det som ska packas NU, räknat från facket (R2-9). Automaten
    // har sålt packet men facket har inget känt saldo: tomt fack = 1 omgång, som Mystery-sidan.
    expect(p.lines.find((l) => l.titleId === mp)?.packNow).toEqual({ batches: 1, packs: 14 });
    expect(qty(p, mp)).toBe(14);
    expect(mysteryBatchesToPack({ batchSize: 14, planPacks: qty(p, mp) })!.batches).toBe(1);
    // Delarna köps för planens omgångar (ledtid + dagar till nästa beställning), som är fler
    // än fackens: delar tar ca en vecka att få hem.
    const batches = partBatches(p);
    expect(batches).toBeGreaterThanOrEqual(2);
    expect(qty(p, p151)).toBe(own151 + 4 * batches);
    expect(qty(p, paldea)).toBe(9 * batches);
    expect(qty(p, hit)).toBe(batches);
    expect(p.lines.find((l) => l.titleId === p151)?.mysteryNeed).toEqual({
      packs: 4 * batches,
      parts: [{ titleId: mp, batches, packs: 4 * batches }],
    });
    expect(p.lines.find((l) => l.titleId === mp)?.mysteryNeed).toBeUndefined();
  });

  it("Vårt lager, Inköp och delägarens lista säger samma antal och samma rad", async () => {
    const v = await viewerFor(owner, orgId);
    const p = await plan(owner);
    const batches = partBatches(p);
    const lager = await loadVartLagerFor(v);
    // Mystery packet självt: samma antal att packa nu på Vårt lager som i planen.
    expect(lager.rows.find((r) => r.titleId === mp)?.needQty).toBe(qty(p, mp));
    const row = lager.rows.find((r) => r.titleId === p151)!;
    expect(row.needQty).toBe(qty(p, p151));
    expect(row.toMystery).toMatchObject({
      packs: 4 * batches,
      all: false,
      into: "Mystery Pack",
      text: `${4 * batches} av dem går till Mystery Pack.`,
    });
    const pal = lager.rows.find((r) => r.titleId === paldea)!;
    expect(pal.needQty).toBe(9 * batches);
    expect(pal.toMystery?.text).toBe("Alla går till Mystery Pack.");

    const today = lager.today;
    const data = await loadPrognosFor(v, { period: { start: today, end: today } });
    const page = buildPageModel(data, new Date());
    const line = page.plan.noSupplierLines.find((l) => l.titleId === p151)!;
    expect(line.suggestQty).toBe(row.needQty);
    expect(line.toMystery?.text).toBe(row.toMystery?.text);

    const list = buyList(lager.rows);
    expect(list.items.find((i) => i.titleId === p151)).toMatchObject({
      qty: row.needQty,
      toMystery: { packs: 4 * batches, all: false, into: "Mystery Pack" },
    });
    expect(list.items.find((i) => i.titleId === paldea)).toMatchObject({
      qty: 9 * batches,
      toMystery: { all: true },
    });
  });

  it("det som ligger hemma av en del dras av, och färdiga mystery packs sänker omgångarna", async () => {
    const before = await plan(owner);
    const batches = partBatches(before);
    await count(paldea, 10);
    const withPaldea = await plan(owner);
    expect(qty(withPaldea, paldea)).toBe(9 * batches - 10);
    // En hel omgång färdig hemma: en omgång mindre att packa, och delarna följer med.
    await count(mp, 14);
    const p = await plan(owner);
    // Den färdiga omgången räcker till det tomma facket: inget att packa nu.
    expect(qty(p, mp)).toBe(0);
    expect(partBatches(p)).toBe(batches - 1);
    expect(qty(p, hit)).toBe(batches - 1);
    expect(qty(p, paldea)).toBe(Math.max(0, 9 * (batches - 1) - 10));
  });

  it("läsaren ser samma plan; påfyllaren får inte läsa den", async () => {
    const a = await plan(owner);
    const b = await plan(reader);
    expect(qty(b, p151)).toBe(qty(a, p151));
    expect(b.lines.find((l) => l.titleId === p151)?.mysteryNeed).toEqual(
      a.lines.find((l) => l.titleId === p151)?.mysteryNeed,
    );
    await expect(plan(refiller)).rejects.toThrow();
  });

  it("−14 hemma och ett tomt fack: planen, Vårt lager och delägarens lista säger 2 omgångar i det lagret", async () => {
    // Någon har fyllt på en omgång utan att trycka Packa: 0 räknat, sedan 14 ut.
    await count(mp, 0);
    await asUser(owner, (tx) =>
      tx.insert(s.stockEvents).values({
        organizationId: orgId,
        locationId: hemma,
        titleId: mp,
        kind: "adjustment",
        quantity: -14,
        note: "Påfyllt utan att packa (test)",
      }),
    );
    const p = await plan(owner);
    // 1 omgång rättar minuset + 1 till det tomma facket, som Mystery-kortet säger.
    expect(p.lines.find((l) => l.titleId === mp)?.packNow).toEqual({
      batches: 2,
      packs: 28,
      fixPlaceId: hemma,
    });
    // Delarna köps för minst de 2 omgångarna.
    expect(partBatches(p)).toBeGreaterThanOrEqual(2);
    const v = await viewerFor(owner, orgId);
    const lager = await loadVartLagerFor(v);
    const row = lager.rows.find((r) => r.titleId === mp)!;
    expect(row).toMatchObject({ home: -14, negative: false, needQty: 28 });
    expect(row.action).toMatchObject({ batches: 2, packs: 28, placeId: hemma });
    expect(buyList(lager.rows).items.find((i) => i.titleId === mp)).toMatchObject({
      qty: 28,
      batches: 2,
      countFirst: false,
      packPlaceId: hemma,
    });
    const data = await loadPrognosFor(v, { period: { start: lager.today, end: lager.today } });
    const line = buildPageModel(data, new Date()).plan.packLines.find((l) => l.titleId === mp)!;
    expect(line.negative).toBe(false);
    expect(line.action).toMatchObject({ batches: 2, placeId: hemma });
  });
});
