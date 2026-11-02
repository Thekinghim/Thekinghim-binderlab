/**
 * Två importer mot samma datakälla körs efter varandra (advisory lock per
 * datakälla), så att dubbletter, titlar och källautomater aldrig skapas två
 * gånger och klassningen alltid är rätt.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "./helpers";
import { awishCsv, countIn, fixture, ordersOf, setupImportOrg } from "./import-fixtures";

describe("parallella importer", () => {
  it("serialiseras: samma fil två gånger samtidigt ger nya en gång och dubbletter en gång", async () => {
    const f = await setupImportOrg();
    const [a, b] = await Promise.all([
      f.run(fixture("orderlista-2026-11-02.csv")),
      f.run(fixture("orderlista-2026-11-02.csv")),
    ]);
    expect([a.summary.new, b.summary.new].sort()).toEqual([0, 3]);
    expect([a.summary.duplicate, b.summary.duplicate].sort()).toEqual([0, 3]);
    expect(await countIn("orders", f.orgId)).toBe(3);
    expect(await countIn("titles", f.orgId)).toBe(2);
    expect(await countIn("title_aliases", f.orgId)).toBe(2);
    expect(await countIn("source_machines", f.orgId)).toBe(2);

    // Tidsintervallen överlappar inte: den andra startade efter att den första var klar.
    const [first, second] = [a, b].sort((x, y) => x.startedAt!.localeCompare(y.startedAt!));
    expect(new Date(second!.startedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(first!.finishedAt!).getTime(),
    );
  });

  it("överlappande filer samtidigt: unionen sparas, inget dubbelt", async () => {
    const f = await setupImportOrg();
    const one = awishCsv(
      Array.from({ length: 40 }, (_, i) => ({
        no: `P${i}`,
        time: "2026-11-02 10:00:00",
        name: `Titel ${i % 7}`,
      })),
    );
    const two = awishCsv(
      Array.from({ length: 40 }, (_, i) => ({
        no: `P${i + 20}`,
        time: "2026-11-02 10:00:00",
        name: `Titel ${(i + 20) % 7}`,
      })),
    );
    const results = await Promise.all([f.run(one), f.run(two), f.run(one)]);
    expect(results.reduce((sum, r) => sum + r.summary.new, 0)).toBe(60);
    expect(results.reduce((sum, r) => sum + r.summary.new + r.summary.duplicate, 0)).toBe(120);
    expect(await countIn("orders", f.orgId)).toBe(60);
    expect(await countIn("titles", f.orgId)).toBe(7);
    expect((await ordersOf(f.orgId)).every((o) => o.title_id !== null)).toBe(true);
  });

  it("en import väntar på låset för datakällan", async () => {
    const f = await setupImportOrg();
    let release: () => void = () => {};
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`binderlab:import:${f.dataSourceId}`}, 0))`,
      );
      locked();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await isLocked;

    let done = false;
    const running = f.run(fixture("orderlista-2026-11-02.csv")).then((r) => {
      done = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(done).toBe(false);
    expect(await countIn("imports", f.orgId)).toBe(0);

    release();
    await holder;
    const r = await running;
    expect(r.summary.new).toBe(3);

    // Förhandsvisningen tar inget lås och blockeras inte.
    await db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`binderlab:import:${f.dataSourceId}`}, 0))`,
      );
      const preview = await f.run(fixture("orderlista-2026-11-02.csv"), { dryRun: true });
      expect(preview.summary.duplicate).toBe(3);
    });
  });
});
