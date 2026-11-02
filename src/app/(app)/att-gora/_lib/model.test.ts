import { describe, expect, it } from "vitest";

import type { TodoItem } from "@/analytics/todos";
import { NBSP } from "@/lib/format";

import {
  buildPage,
  dismissedViews,
  formatFigure,
  inScope,
  joinSv,
  kindSummary,
  primaryFigures,
  stakeOf,
  suggestRefill,
  SIGNAL_BUDGET,
  unpricedOf,
  type ModelInput,
} from "./model";

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const S1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function item(p: Partial<TodoItem> & Pick<TodoItem, "key" | "kind" | "level">): TodoItem {
  return {
    fingerprint: "fp",
    urgency: 0,
    atStakeOre: null,
    daysLeft: null,
    title: p.key,
    detail: "Detalj.",
    link: "/",
    ...p,
    evidence: {
      rule: "Regel.",
      period: null,
      orderIds: [],
      dates: [],
      titleIds: [],
      machineIds: [],
      storeIds: [],
      recipientIds: [],
      figures: [],
      ...p.evidence,
    },
  };
}

function refill(
  machineId: string,
  level: "now" | "soon",
  atStakeOre: number,
  onHand = 1,
): TodoItem {
  return item({
    key: `refill:${machineId}:${T1}`,
    kind: "refill",
    level,
    atStakeOre,
    daysLeft: 0,
    title: "Fyll på Titel 1 i Automat",
    evidence: {
      rule: "Lagret räcker under 2,5 dagar.",
      period: null,
      orderIds: [],
      dates: [],
      titleIds: [T1],
      machineIds: [machineId],
      storeIds: [],
      recipientIds: [],
      figures: [
        { key: "onHand", label: "I lager", value: onHand, unit: "packs" },
        { key: "unitsInWindow", label: "Sålda pack i fönstret", value: 36, unit: "packs" },
        { key: "windowDays", label: "Dagar i fönstret", value: 14, unit: "days" },
        { key: "revenueInWindowOre", label: "Intäkt i fönstret", value: 624_000, unit: "ore" },
        { key: "daysLeftTenths", label: "Räcker (dagar)", value: 3, unit: "tenths" },
      ],
    },
    action: {
      kind: "register-refill",
      label: "Registrera påfyllning",
      params: { machineId, titleId: T1 },
    },
  });
}

const missingPrice = item({
  key: `missing-price:${T2}`,
  kind: "missing-price",
  level: "later",
  atStakeOre: 52_150,
  title: "Lägg in inköpspris för Titel 2",
  link: `/inkopspriser?titel=${T2}`,
  evidence: {
    rule: "Saknar inköpspris.",
    period: null,
    orderIds: [],
    dates: [],
    titleIds: [T2],
    machineIds: [],
    storeIds: [],
    recipientIds: [],
    figures: [
      { key: "unpricedOrders", label: "Order utan pris", value: 15, unit: "count" },
      { key: "unpricedRevenueOre", label: "Intäkt utan pris", value: 223_500, unit: "ore" },
    ],
  },
  action: { kind: "add-price", label: "Lägg in inköpspris", params: { titleId: T2 } },
});

function input(todos: TodoItem[], over: Partial<ModelInput> = {}): ModelInput {
  return {
    todos,
    role: "owner",
    economy: true,
    titles: [
      { id: T1, name: "Titel 1" },
      { id: T2, name: "Titel 2" },
    ],
    machines: [
      { id: M1, name: "Automat 1", code: "BL-001", storeId: S1 },
      { id: M2, name: "Automat 2", code: "BL-002", storeId: null },
    ],
    machineStock: [],
    warehouse: new Map([[T1, 10]]),
    scope: { storeId: null, machineId: null },
    computedAt: "09:42",
    ...over,
  };
}

describe("text", () => {
  it("räknar upp sorterna i fast ordning med 'och'", () => {
    expect(joinSv(["a", "b", "c"])).toBe("a, b och c");
    expect(kindSummary([missingPrice, refill(M1, "now", 1), refill(M2, "now", 1)])).toBe(
      `2${NBSP}påfyllningar och 1${NBSP}titel utan inköpspris`,
    );
  });

  it("formaterar underlagets enheter", () => {
    expect(formatFigure({ value: 294_667, unit: "ore" })).toBe(`2${NBSP}947${NBSP}kr`);
    expect(formatFigure({ value: 3, unit: "tenths" })).toBe("0,3");
    expect(formatFigure({ value: 1, unit: "days" })).toBe(`1${NBSP}dag`);
    expect(formatFigure({ value: 5_000, unit: "bp" })).toBe(`50${NBSP}%`);
  });
});

describe("buildPage", () => {
  it("grupperar efter brådska och skriver rubriken med det mest brådskande först", () => {
    const page = buildPage(
      input([refill(M1, "now", 294_667), refill(M2, "soon", 100_000), missingPrice]),
    );
    expect(page.groups.map((g) => g.level)).toEqual(["now", "soon", "later"]);
    expect(page.groups.map((g) => g.index)).toEqual([1, 2, 3]);
    expect(page.header.title).toBe(`3${NBSP}saker att göra.`);
    expect(page.header.aside).toBe("1 måste göras i dag.");
    expect(page.header.description).toBe(
      `Först: Fyll på Titel 1 i Automat, räcker 0,3${NBSP}d. ` +
        `3${NBSP}947${NBSP}kr i intäkt står på spel de närmaste 7 dagarna.`,
    );
    expect(page.header.meta.find((m) => m.label === "I risk 7 d")?.value).toBe(
      `3${NBSP}947${NBSP}kr`,
    );
    // Intäkt utan inköpspris är inte i risk och står som eget mått.
    expect(page.header.meta.find((m) => m.label === "Utan inköpspris")?.value).toBe(
      `2${NBSP}235${NBSP}kr`,
    );
  });

  it("räknar bara påfyllning och tysta automater som intäkt i risk", () => {
    const stale = item({
      key: `stale-machine:${M2}`,
      kind: "stale-machine",
      level: "soon",
      atStakeOre: 50_000,
    });
    const dup = item({
      key: `duplicate-title:${T1}:${T2}`,
      kind: "duplicate-title",
      level: "later",
      atStakeOre: 70_000,
    });
    expect(stakeOf([refill(M1, "now", 100_000), stale, missingPrice, dup])).toBe(150_000);
    expect(unpricedOf([missingPrice, refill(M1, "now", 1)])).toBe(223_500);
    const later = buildPage(input([missingPrice])).groups[0]!;
    expect(later.aside).toBe(
      `1${NBSP}titel utan inköpspris, 2${NBSP}235${NBSP}kr i intäkt saknar inköpspris.`,
    );
    expect(later.aside).not.toContain("i risk");
  });

  it("skriver påfyllningar som påfyllningar och döljer nivåer utan punkter", () => {
    const page = buildPage(
      input([refill(M1, "soon", 1), refill(M2, "soon", 1)], { role: "refiller", economy: false }),
    );
    expect(page.header.title).toBe(`2${NBSP}påfyllningar att göra.`);
    expect(page.header.aside).toBe("Inget måste göras i dag.");
    expect(page.header.description.startsWith("Först: Fyll på")).toBe(true);
    expect(page.header.meta.map((m) => m.label)).toEqual(["Snart", "Beräknat"]);
  });

  it("skriver automatkoden med hårt bindestreck", () => {
    const row = buildPage(input([refill(M1, "now", 1)])).groups[0]!.items[0]!;
    expect(row.eyebrow).toBe("Påfyllning · BL\u2011001");
  });

  it("visar inga belopp för påfyllaren", () => {
    const page = buildPage(
      input([refill(M1, "now", 294_667)], { role: "refiller", economy: false }),
    );
    const json = JSON.stringify(page);
    expect(json).not.toMatch(/kr\b/);
    expect(page.header.meta.map((m) => m.label)).not.toContain("I risk 7 d");
    expect(page.groups[0]!.items[0]!.evidence.map((e) => e.label)).not.toContain(
      "Intäkt i fönstret",
    );
  });

  it("håller signalbudgeten: högst tre kritiska markeringar", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      item({ key: `stale-machine:${i}`, kind: "stale-machine", level: "now" }),
    );
    const page = buildPage(input(many));
    const statuses = page.groups[0]!.items.map((i) => i.status);
    expect(statuses.filter((s) => s === "critical")).toHaveLength(SIGNAL_BUDGET);
    expect(statuses.slice(SIGNAL_BUDGET)).toEqual(["warning", "warning"]);
    expect(page.groups[0]!.items.every((i) => i.statusText === "I dag")).toBe(true);
  });

  it("säger tydligt när inget finns att göra", () => {
    const page = buildPage(input([]));
    expect(page.total).toBe(0);
    expect(page.header.title).toBe("Inget att göra.");
  });

  it("ger påfyllningen ett förslag och centrallagrets saldo", () => {
    const action = buildPage(input([refill(M1, "now", 1)])).groups[0]!.items[0]!.action;
    expect(action).toMatchObject({
      kind: "register-refill",
      machineCode: "BL-001",
      titleName: "Titel 1",
      onHand: 1,
      warehouseOnHand: 10,
      suggested: 10,
    });
  });

  it("länkar bara till sidor rollen får öppna", () => {
    const owner = buildPage(input([missingPrice])).groups[0]!.items[0]!;
    expect(owner.action).toEqual({
      kind: "link",
      label: "Lägg in inköpspris",
      href: `/inkopspriser?titel=${T2}`,
    });
    const stale = item({
      key: `stale-machine:${M1}`,
      kind: "stale-machine",
      level: "now",
      link: `/automater/${M1}`,
      evidence: { ...missingPrice.evidence, machineIds: [M1], figures: [] },
    });
    const refiller = buildPage(input([stale], { role: "refiller", economy: false }));
    expect(refiller.groups[0]!.items[0]!.action).toEqual({
      kind: "link",
      label: "Visa lagret",
      href: `/lager?automat=${M1}`,
    });
  });
});

describe("filter", () => {
  it("visar automatens punkter och punkter för hela organisationen", () => {
    const scoped = input([refill(M1, "now", 1), refill(M2, "now", 1), missingPrice], {
      scope: { storeId: null, machineId: M2 },
    });
    expect(inScope(refill(M1, "now", 1), scoped)).toBe(false);
    const page = buildPage(scoped);
    expect(page.total).toBe(2);
    expect(page.hiddenByScope).toBe(1);
    expect(page.header.description).toContain(`Filtret döljer 1${NBSP}punkt för andra automater.`);
  });

  it("butiksfiltret följer automatens butik", () => {
    const scoped = input([refill(M1, "now", 1), refill(M2, "now", 1)], {
      scope: { storeId: S1, machineId: null },
    });
    expect(buildPage(scoped).total).toBe(1);
  });
});

describe("avbockade", () => {
  it("visar avbockade inom filtret med etikett och vem som bockade av", () => {
    const dismissed = [
      { key: `refill:${M1}:${T1}`, title: "Fyll på Titel 1 i Automat 1", when: "nyss", by: "dig" },
      { key: `refill:${M2}:${T1}`, title: null, when: "igår 17:17", by: null },
      {
        key: `missing-price:${T2}`,
        title: "Lägg in inköpspris för Titel 2",
        when: "nyss",
        by: "Anna",
      },
    ];
    const all = dismissedViews(input([], { dismissed }));
    expect(all.map((d) => d.eyebrow)).toEqual([
      "Påfyllning · BL\u2011001",
      "Påfyllning · BL\u2011002",
      "Inköpspris",
    ]);
    expect(all[0]!.meta).toBe("Avbockad nyss av dig.");
    expect(all[1]!.title).toBe("Punkt utan sparad rubrik.");
    expect(all[1]!.meta).toBe("Avbockad igår 17:17.");
    const scoped = dismissedViews(
      input([], { dismissed, scope: { storeId: null, machineId: M2 } }),
    );
    expect(scoped.map((d) => d.key)).toEqual([`refill:${M2}:${T1}`, `missing-price:${T2}`]);
  });
});

describe("mått och förslag", () => {
  it("skriver Slut när automaten är tom", () => {
    const figures = primaryFigures(refill(M1, "now", 1, 0), false);
    expect(figures.find((f) => f.label === "Räcker")?.value).toBe("Slut");
  });

  it("föreslår att fylla till fönstrets försäljning, högst centrallagret", () => {
    expect(suggestRefill(1, 36, null)).toBe(35);
    expect(suggestRefill(1, 36, 12)).toBe(12);
    expect(suggestRefill(40, 36, null)).toBe(1);
    expect(suggestRefill(-2, 4, 0)).toBe(4);
    expect(suggestRefill(0, null, null)).toBe(1);
  });
});
