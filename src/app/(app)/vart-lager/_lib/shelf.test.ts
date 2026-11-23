import { describe, expect, it } from "vitest";

import type { VartLagerRow } from "./model";
import {
  daysBetween,
  daysShare,
  homeShare,
  shelfCounts,
  shelfFilter,
  shelfFlag,
  shelfOrder,
  shelfTone,
  wayBadge,
  wayHeadline,
} from "./shelf";

const row = (titleId: string, over: Partial<VartLagerRow> = {}): VartLagerRow =>
  ({
    titleId,
    name: titleId.toUpperCase(),
    home: 10,
    byPlace: {},
    latestByPlace: {},
    inMachines: 5,
    sold7: 7,
    daysLeft: 10,
    lastsDays: 15,
    retired: false,
    status: "ok",
    runsOut: false,
    negative: false,
    unitCostOre: 5_000,
    valueOre: 50_000,
    latest: null,
    own: false,
    needQty: 0,
    action: null,
    fact: "",
    toMystery: null,
    ...over,
  }) as VartLagerRow;

const order = { kind: "order", qty: 36, unit: "st", packs: 36, batches: null, text: "" } as const;

describe("Vårt lagers hylla", () => {
  it("ton och etikett följer Slut/Lågt och inköpsplanen", () => {
    expect(shelfTone(row("a"))).toBe("ok");
    expect(shelfFlag(row("a"))).toBeNull();
    expect(shelfTone(row("b", { runsOut: true, home: 3 }))).toBe("crit");
    expect(shelfFlag(row("b", { runsOut: true, home: 3 }))).toBe("Slut snart");
    expect(shelfFlag(row("c", { home: 0, inMachines: 2 }))).toBe("Slut");
    const d = row("d", { action: order as unknown as VartLagerRow["action"] });
    expect(shelfTone(d)).toBe("warn");
    expect(shelfFlag(d)).toBe("Lågt");
    expect(shelfTone(row("e", { retired: true, runsOut: true }))).toBe("idle");
  });

  it("ordning: rött, orange, lugnt; kortast räcker först; utgår sist", () => {
    const rows = [
      row("ok-long", { daysLeft: 80 }),
      row("ok-short", { daysLeft: 30 }),
      row("warn", { action: order as unknown as VartLagerRow["action"], daysLeft: 40 }),
      row("crit", { runsOut: true, daysLeft: 3 }),
      row("old", { retired: true, daysLeft: 0 }),
      row("none", { daysLeft: null }),
    ];
    expect(shelfOrder(rows).map((r) => r.titleId)).toEqual([
      "crit",
      "warn",
      "ok-short",
      "ok-long",
      "none",
      "old",
    ]);
  });

  it("chips: Alla utan utgångna, Köp in, På väg, Utgår", () => {
    const rows = [
      row("a"),
      row("b", { action: order as unknown as VartLagerRow["action"] }),
      row("c", { retired: true }),
    ];
    const way = new Set(["a", "c"]);
    expect(shelfCounts(rows, way)).toEqual({ alla: 2, kop: 1, vag: 2, utgar: 1 });
    expect(shelfFilter(rows, "kop", way).map((r) => r.titleId)).toEqual(["b"]);
  });

  it("staplar", () => {
    expect(daysShare(null)).toBe(0);
    expect(daysShare(45)).toBe(0.5);
    expect(daysShare(400)).toBe(1);
    expect(homeShare(0, 0)).toBeNull();
    expect(homeShare(30, 10)).toBe(0.75);
    expect(homeShare(-3, 10)).toBe(0);
  });

  it("på väg: märken och rubrik", () => {
    expect(daysBetween("2026-11-23", "2026-11-19")).toBe(-4);
    expect(wayBadge("2026-11-19", "2026-11-23", true)).toBe("4 d sen");
    expect(wayBadge("2026-11-23", "2026-11-23", false)).toBe("i dag");
    expect(wayBadge("2026-11-24", "2026-11-23", false)).toBe("i morgon");
    expect(wayBadge("2026-11-26", "2026-11-23", false)).toBe("tors");
    expect(wayHeadline("2026-11-19", "2026-11-23", true)).toBe("Skulle kommit tors · 4 d sen");
    expect(wayHeadline("2026-11-26", "2026-11-23", false)).toBe("Väntas tors");
  });
});
