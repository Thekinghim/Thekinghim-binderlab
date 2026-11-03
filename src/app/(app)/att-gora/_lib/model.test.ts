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
        `Den står för 2${NBSP}947${NBSP}kr av 3${NBSP}947${NBSP}kr i intäkt i risk de närmaste 7 dagarna.`,
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
      `1${NBSP}titel utan inköpspris, 2${NBSP}235${NBSP}kr i intäkt räknas inte in i vinsten.`,
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

  it("påstår inte att lagret räcker när saldot är okänt", () => {
    const page = buildPage(input([], { unknownStockMachineIds: [M1] }));
    expect(page.unknownStock).toBe(1);
    expect(page.header.title).toBe(`Saldo okänt i 1${NBSP}automat.`);
    expect(page.header.aside).not.toMatch(/räcker/);
    expect(page.header.meta.map((m) => m.label)).toContain("Saldo okänt");
  });

  it("räknar okänt saldo bara inom filtret", () => {
    const page = buildPage(
      input([], { unknownStockMachineIds: [M1], scope: { storeId: null, machineId: M2 } }),
    );
    expect(page.unknownStock).toBe(0);
    expect(page.header.title).toBe("Inget att göra.");
  });

  it("nämner okänt saldo bredvid andra punkter", () => {
    const page = buildPage(input([refill(M2, "now", 1)], { unknownStockMachineIds: [M1] }));
    expect(page.header.description).toContain(`Saldo okänt i 1${NBSP}automat.`);
  });

  it("ger påfyllningen ett förslag och centrallagrets saldo", () => {
    const action = buildPage(input([refill(M1, "now", 1)])).groups[0]!.items[0]!.action;
    expect(action).toMatchObject({
      kind: "register-refill",
      machineCode: "BL\u2011001",
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

describe("vem", () => {
  it("punkten får sin tilldelade person, annars Båda", () => {
    const a = refill(M1, "now", 1);
    const b = refill(M2, "now", 1);
    const page = buildPage(input([a, b], { assignees: new Map([[a.key, "u-co"]]) }));
    const items = page.groups.flatMap((g) => g.items);
    expect(items.find((x) => x.key === a.key)!.assignee).toBe("u-co");
    expect(items.find((x) => x.key === b.key)!.assignee).toBe("");
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
    expect(all[0]!.meta).toBe("Klar nyss av dig.");
    expect(all[1]!.title).toBe("Punkt utan sparad rubrik.");
    expect(all[1]!.meta).toBe("Klar igår 17:17.");
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

describe("integrationens punkter: avtal, rapportutkast, larm och förlorad försäljning", () => {
  const contract = item({
    key: "contract:c1:2027-02-28",
    kind: "contract",
    level: "soon",
    daysLeft: 28,
    title: "Avtalet med ICA Nära löper ut 28 feb. 2027",
    link: "/avtal#avtal-c1",
    evidence: {
      rule: "Sista uppsägningsdag.",
      period: null,
      orderIds: [],
      dates: [],
      titleIds: [],
      machineIds: [],
      storeIds: [S1],
      recipientIds: [],
      figures: [
        {
          key: "daysToDeadline",
          label: "Dagar till sista uppsägningsdag",
          value: 28,
          unit: "days",
        },
        { key: "daysToEnd", label: "Dagar till avtalets slut", value: 118, unit: "days" },
      ],
    },
    action: { kind: "open-contract", label: "Öppna avtalet", params: { contractId: "c1" } },
  });
  const review = item({
    key: "report-review:2026-10",
    kind: "report-review",
    level: "later",
    daysLeft: 28,
    title: "Granska 3 rapportutkast för oktober",
    link: "/rapporter?manad=2026-10#granska",
    evidence: {
      rule: "Utkast.",
      period: null,
      orderIds: [],
      dates: [],
      titleIds: [],
      machineIds: [],
      storeIds: [],
      recipientIds: [],
      figures: [{ key: "drafts", label: "Utkast", value: 3, unit: "count" }],
    },
    action: { kind: "review-report", label: "Granska utkasten", params: { month: "2026-10" } },
  });
  const alert = item({
    key: `alert:machine:${M2}`,
    kind: "alert",
    level: "now",
    title: "BL-002 har slutat sälja",
    link: `/drift/automat/${M2}`,
    evidence: {
      rule: "Misstänkt fel.",
      period: null,
      orderIds: [],
      dates: [],
      titleIds: [],
      machineIds: [M2],
      storeIds: [],
      recipientIds: [],
      figures: [{ key: "openHours", label: "Öppet", value: 3, unit: "hours" }],
    },
    action: { kind: "open-alert", label: "Öppna automaten", params: { alertId: "a1" } },
  });

  it("visar etikett, mått och länk för varje ny sort", () => {
    const page = buildPage(input([alert, contract, review]));
    const views = page.groups.flatMap((g) => g.items);
    const byKey = new Map(views.map((v) => [v.key, v]));
    expect(byKey.get(contract.key)?.eyebrow).toBe("Avtal");
    expect(byKey.get(contract.key)?.figures).toEqual([
      { label: "Säg upp inom", value: `28${NBSP}dagar` },
      { label: "Slutar om", value: `118${NBSP}dagar` },
    ]);
    expect(byKey.get(contract.key)?.action).toEqual({
      kind: "link",
      label: "Öppna avtalet",
      href: "/avtal#avtal-c1",
    });
    expect(byKey.get(review.key)?.figures[0]).toEqual({ label: "Utkast", value: "3" });
    expect(byKey.get(review.key)?.action).toMatchObject({
      href: "/rapporter?manad=2026-10#granska",
    });
    expect(byKey.get(alert.key)?.eyebrow).toBe(`Larm · BL${"‑"}002`);
    expect(byKey.get(alert.key)?.figures).toEqual([{ label: "Öppet", value: `3${NBSP}h` }]);
    expect(kindSummary([alert, contract, review])).toBe(
      `1${NBSP}larm, 1${NBSP}utkast att granska och 1${NBSP}avtal att se över`,
    );
  });

  it("avtalet följer butiksfiltret; larmet följer automaten", () => {
    expect(
      inScope(contract, { scope: { storeId: S1, machineId: null }, machines: input([]).machines }),
    ).toBe(true);
    expect(
      inScope(contract, {
        scope: { storeId: "annan", machineId: null },
        machines: input([]).machines,
      }),
    ).toBe(false);
    expect(
      inScope(alert, { scope: { storeId: null, machineId: M1 }, machines: input([]).machines }),
    ).toBe(false);
  });

  it("beloppet i risk kopplas inte till ett utkast som står först", () => {
    const first = { ...review, level: "now" as const, urgency: 1e12 };
    const page = buildPage(input([first, refill(M1, "soon", 294_667)]));
    expect(page.header.description).toBe(
      "Först: Granska 3 rapportutkast för oktober. " +
        `Påfyllningarna: 2${NBSP}947${NBSP}kr i intäkt i risk de närmaste 7 dagarna.`,
    );
  });

  it("med bara automatfilter följer avtal och rapporter automatens butik (som Hem)", () => {
    const machines = input([]).machines;
    const m = machines.find((x) => x.storeId === S1)!;
    const other = machines.find((x) => x.storeId !== S1);
    expect(inScope(contract, { scope: { storeId: null, machineId: m.id }, machines })).toBe(true);
    if (other) {
      expect(inScope(contract, { scope: { storeId: null, machineId: other.id }, machines })).toBe(
        false,
      );
    }
    expect(
      inScope(contract, {
        scope: { storeId: null, machineId: m.id },
        machines: machines.map((x) => (x.id === m.id ? { ...x, storeId: "annan" } : x)),
      }),
    ).toBe(false);
  });

  it("påfyllning med förlorad försäljning visar beloppet, bara för ekonomi", () => {
    const base = refill(M1, "now", 62_400, 0);
    const lost = {
      ...base,
      evidence: {
        ...base.evidence,
        figures: [
          ...base.evidence.figures,
          {
            key: "lostRevenueOre",
            label: "Förlorat när slut, 14 d",
            value: 31_200,
            unit: "ore" as const,
          },
        ],
      },
    };
    expect(primaryFigures(lost, true)).toContainEqual({
      label: "Förlorat 14 d",
      value: `312${NBSP}kr`,
    });
    expect(primaryFigures(lost, false).some((f) => f.label.startsWith("Förlorat"))).toBe(false);
  });

  it("läsaren och påfyllaren får ingen länk till sidor de inte ser", () => {
    const page = buildPage(input([contract, review], { role: "refiller", economy: false }));
    for (const v of page.groups.flatMap((g) => g.items)) expect(v.action).toBeNull();
  });
});

describe("tyst titel", () => {
  const silentTitle = item({
    key: `silent-title:${M1}:${T1}`,
    kind: "silent-title",
    level: "now",
    atStakeOre: 34_300,
    title: "Titel 1 i Automat 1 har inte sålt på 3 dygn",
    link: `/drift/automat/${M1}`,
    evidence: {
      rule: "Tyst titel.",
      period: null,
      orderIds: [],
      dates: [],
      titleIds: [T1],
      machineIds: [M1],
      storeIds: [],
      recipientIds: [],
      figures: [
        { key: "silentHours", label: "Timmar utan försäljning", value: 72, unit: "hours" },
        { key: "onHand", label: "Pack i facket", value: 5, unit: "packs" },
      ],
    },
    action: { kind: "open-machine", label: "Öppna automaten", params: { machineId: M1 } },
  });

  it("har etikett, mått, knapp och räknas som intäkt i risk", () => {
    const page = buildPage(input([silentTitle]));
    const view = page.groups[0]!.items[0]!;
    expect(view.eyebrow).toBe(`Tyst titel · BL${"‑"}001`);
    expect(view.figures).toEqual([
      { label: "Tyst", value: `72${NBSP}h` },
      { label: "I facket", value: `5${NBSP}pack` },
      { label: "I risk 7 d", value: `343${NBSP}kr` },
    ]);
    expect(view.action).toEqual({
      kind: "link",
      label: "Öppna automaten",
      href: `/drift/automat/${M1}`,
    });
    expect(stakeOf([silentTitle])).toBe(34_300);
    expect(kindSummary([silentTitle])).toBe(`1${NBSP}tyst titel`);
  });

  it("påfyllaren ser punkten utan belopp och avbockningen följer automatfiltret", () => {
    const page = buildPage(input([silentTitle], { role: "refiller", economy: false }));
    expect(page.groups[0]!.items[0]!.figures.map((f) => f.label)).toEqual(["Tyst", "I facket"]);
    const dismissed = dismissedViews(
      input([], {
        scope: { storeId: null, machineId: M2 },
        dismissed: [{ key: silentTitle.key, title: "X", when: "i dag", by: null }],
      }),
    );
    expect(dismissed).toEqual([]);
  });
});
