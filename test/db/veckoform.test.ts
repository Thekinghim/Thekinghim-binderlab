/**
 * Veckans form per automat ur databasen (runda 2, T4-3, loadWeekShapes) mot testdatabasen:
 *
 * - formen räknas ur de senaste 28 dagarnas försäljning (lagerhändelserna), per automat,
 * - en automat med under 28 dagars försäljning får ingen form (platt snitt),
 * - laddaren ger exakt samma form som när den räknas ur en längre orderlista (Att göra),
 * - påfyllaren får läsa den (inga belopp), en annan organisation får ingenting.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

import { weekShapes } from "@/analytics/sellout/week-shape";
import { addDays, dayOfWeek, type IsoDate } from "@/domain";
import { querySaleEventsAsOrders } from "@/server/data/core/queries";
import { loadWeekShapes } from "@/server/data/week-shapes";

import { asUser, createMember, createOrg, createUser, type TestUser } from "./helpers";
import { awishCsv, mapMachine, setupImportOrg, type ImportFixture } from "./import-fixtures";

vi.mock("server-only", () => ({}));

const TODAY = "2026-11-12" as IsoDate; // torsdag
const AS_OF = "2026-11-11" as IsoDate;
/** Lördag 4, torsdag och fredag 2, övriga 1 pack per dag: 12 i veckan. */
const perDay = (weekday: number) => (weekday === 6 ? 4 : weekday === 4 || weekday === 5 ? 2 : 1);

let f: ImportFixture;
let refiller: TestUser;
let outsider: TestUser;
let m1: string;
let m2: string;

beforeAll(async () => {
  f = await setupImportOrg();
  refiller = await createMember(f.orgId, "refiller");
  outsider = await createUser();
  await createOrg(outsider);
  m1 = await mapMachine(f, "BL-001 ICA Lund", "BL-001");
  m2 = await mapMachine(f, "BL-002 Nya hallen", "BL-002");
  const orders: { no: string; machine: string; time: string }[] = [];
  let no = 1;
  // BL-001: 42 dagar. BL-002: bara de senaste 20 dagarna.
  for (let d = 0; d < 42; d++) {
    const date = addDays(AS_OF, -d);
    for (let i = 0; i < perDay(dayOfWeek(date)); i++) {
      orders.push({ no: String(no++), machine: "BL-001 ICA Lund", time: `${date} 12:0${i}:00` });
      if (d < 20) {
        orders.push({
          no: String(no++),
          machine: "BL-002 Nya hallen",
          time: `${date} 13:0${i}:00`,
        });
      }
    }
  }
  // I dag: räknas inte i formen.
  for (let i = 0; i < 9; i++) {
    orders.push({ no: String(no++), machine: "BL-001 ICA Lund", time: `${TODAY} 12:0${i}:00` });
  }
  const result = await f.run(awishCsv(orders));
  expect(result.summary?.new).toBe(orders.length);
}, 180_000);

describe("veckans form ur databasen", () => {
  it("28 dagar per automat; under 28 dagars försäljning ingen form", async () => {
    const shapes = await asUser(f.owner, (tx) => loadWeekShapes(tx, f.orgId, TODAY));
    expect([...shapes.keys()]).toEqual([m1]);
    expect(shapes.has(m2)).toBe(false);
    const shape = shapes.get(m1)!;
    expect(shape.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(shape[5]).toBeCloseTo(4 / 12, 12); // lördag
    expect(shape[3]).toBeCloseTo(2 / 12, 12); // torsdag
    expect(shape[0]).toBeCloseTo(1 / 12, 12); // måndag
  });

  it("samma form som ur en längre orderlista (45 dagar, som Att göra)", async () => {
    const [loaded, fromOrders] = await asUser(f.owner, async (tx) => {
      const orders = await querySaleEventsAsOrders(tx, f.orgId, {
        start: addDays(TODAY, -45),
        end: TODAY,
      });
      return [await loadWeekShapes(tx, f.orgId, TODAY), weekShapes(orders, { asOf: AS_OF })];
    });
    expect(fromOrders.get(m1)).toEqual(loaded.get(m1));
    expect([...fromOrders.keys()]).toEqual([m1]);
  });

  it("automaten togs i drift inom fönstret: ingen form", async () => {
    const shapes = await asUser(f.owner, (tx) =>
      loadWeekShapes(tx, f.orgId, TODAY, [{ id: m1, activeFrom: "2026-10-25" as IsoDate }]),
    );
    expect(shapes.size).toBe(0);
  });

  it("påfyllaren får läsa formen; en annan organisation får ingenting", async () => {
    const own = await asUser(refiller, (tx) => loadWeekShapes(tx, f.orgId, TODAY));
    expect([...own.keys()]).toEqual([m1]);
    const other = await asUser(outsider, (tx) => loadWeekShapes(tx, f.orgId, TODAY));
    expect(other.size).toBe(0);
  });
});
