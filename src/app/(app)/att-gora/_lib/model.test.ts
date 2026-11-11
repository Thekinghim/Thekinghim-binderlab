import { describe, expect, it } from "vitest";

import type { TodoItem } from "@/analytics/todos";
import { fillMachines, maxFill, pairKey, suggestFill } from "@/app/fyll-pa/_lib/model";
import { NBSP } from "@/lib/format";

import {
  buildPage,
  extraTodos,
  plainWords,
  dismissedViews,
  formatFigure,
  inScope,
  joinSv,
  kindSummary,
  primaryFigures,
  stakeOf,
  refillHome,
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
  titleId: string = T1,
): TodoItem {
  return item({
    key: `refill:${machineId}:${titleId}`,
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
      titleIds: [titleId],
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
      params: { machineId, titleId },
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

  it("byter facktermer mot vanliga ord", () => {
    expect(plainWords(`5${NBSP}pack i facket · brukar sälja`)).toBe(
      `5${NBSP}pack i automaten · brukar sälja`,
    );
    expect(plainWords("Pack i facket")).toBe("Pack i automaten");
  });

  it("formaterar underlagets enheter", () => {
    expect(formatFigure({ value: 294_667, unit: "ore" })).toBe(`2${NBSP}947${NBSP}kr`);
    expect(formatFigure({ value: 3, unit: "tenths" })).toBe("0,3");
    expect(formatFigure({ value: 1, unit: "days" })).toBe(`1${NBSP}dag`);
    expect(formatFigure({ value: 5_000, unit: "bp" })).toBe(`50${NBSP}%`);
  });
});

describe("besök: en rad per automat", () => {
  const T3 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  // 2 nov. 2026 är en måndag.
  const TODAY = "2026-11-02";
  const todos = [
    refill(M1, "now", 50_040, 0, T1),
    refill(M2, "soon", 20_000, 2, T1),
    refill(M1, "soon", 30_000, 2, T2),
    refill(M1, "soon", 149_960, 3, T3),
    refill(M2, "soon", 10_000, 2, T2),
    refill(M2, "soon", 0, 2, T3),
  ];
  const visitPlan = {
    days: [
      {
        date: "2026-11-02",
        stops: [{ machineId: M1, needBy: "2026-11-02", late: false, totalPacks: 38 }],
      },
      {
        date: "2026-11-05",
        stops: [{ machineId: M2, needBy: "2026-11-05", late: false, totalPacks: 12 }],
      },
    ],
  } as const;
  const page = () =>
    buildPage(
      input(todos, {
        today: TODAY,
        visitPlan,
        places: new Map([[S1, { address: "Storgatan 1", city: "Lund", location: null }]]),
      }),
    );

  it("6 påfyllningar i 2 automater blir 2 besök med summerade pack och kronor", () => {
    const p = page();
    expect(p.total).toBe(2);
    expect(p.header.title).toBe(`2${NBSP}besök att göra.`);
    expect(p.header.aside).toBe("1 i dag.");
    expect(p.header.description).toBe("Först: Åk till BL\u2011001 i dag.");
    const rows = p.groups.flatMap((g) => g.rows);
    expect(rows.map((r) => r.type)).toEqual(["visit", "visit"]);
    const [v1, v2] = rows.map((r) => (r.type === "visit" ? r.visit : null));
    expect(v1?.title).toBe("Åk till BL\u2011001 i dag.");
    expect(v1?.facts).toBe(`3${NBSP}titlar · 38${NBSP}pack · 2${NBSP}300${NBSP}kr i risk`);
    expect(v1?.items.map((t) => t.key)).toEqual([
      `refill:${M1}:${T1}`,
      `refill:${M1}:${T2}`,
      `refill:${M1}:${T3}`,
    ]);
    // Dagen är besöksplanens needBy (torsdag 5 nov.), inte punktens egen dag.
    expect(v2?.title).toBe("Åk till BL\u2011002 senast torsdag.");
    expect(v2?.facts).toBe(`3${NBSP}titlar · 12${NBSP}pack · 300${NBSP}kr i risk`);
    // Rubrikens summa är summan av raderna.
    expect(p.header.meta.find((m) => m.label === "I risk 7 d")?.value).toBe(`2${NBSP}600${NBSP}kr`);
  });

  it("besöket står i sin mest brådskande punkts grupp, med alla automatens titlar", () => {
    const p = page();
    expect(p.groups.map((g) => g.level)).toEqual(["now", "soon"]);
    expect(p.groups[0]!.aside).toBe(`1${NBSP}besök · 2${NBSP}300${NBSP}kr i risk.`);
    expect(p.groups[0]!.items).toHaveLength(3);
    expect(p.header.meta.slice(0, 2)).toEqual([
      { label: "I dag", value: "1" },
      { label: "Snart", value: "1" },
    ]);
  });

  it("länkar till Fyll på, Ta med-listan och Google Maps när butiken har adress", () => {
    const [v1, v2] = page()
      .groups.flatMap((g) => g.rows)
      .map((r) => (r.type === "visit" ? r.visit : null));
    expect(v1?.fillHref).toBe(`/fyll-pa/${M1}`);
    expect(v1?.bringHref).toBe("/fyll-pa");
    expect(v1?.mapsHref).toContain("https://www.google.com/maps/dir/?");
    expect(v1?.mapsHref).toContain("Storgatan");
    // Automaten står inte i någon butik: ingen karta.
    expect(v2?.mapsHref).toBeNull();
  });

  it("påfyllaren ser inga kronor, och utan plan står besöket utan dag", () => {
    const p = buildPage(input(todos, { role: "refiller", economy: false, today: TODAY }));
    const visits = p.groups
      .flatMap((g) => g.rows)
      .flatMap((r) => (r.type === "visit" ? [r.visit] : []));
    expect(visits.map((v) => v.title)).toEqual([
      "Åk till BL\u2011001 i dag.",
      "Åk till BL\u2011002 snart.",
    ]);
    expect(visits.map((v) => v.facts)).toEqual([`3${NBSP}titlar`, `3${NBSP}titlar`]);
  });

  it("andra sorter står kvar som egna rader", () => {
    const p = buildPage(input([...todos, missingPrice], { today: TODAY, visitPlan }));
    expect(p.total).toBe(3);
    expect(p.header.title).toBe(`3${NBSP}saker att göra.`);
    expect(p.groups.at(-1)!.rows).toMatchObject([
      { type: "todo", item: { kind: "missing-price" } },
    ]);
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
    expect(page.header.aside).toBe("1 i dag.");
    // Bara det första; beloppet i risk står i metablocket.
    expect(page.header.description).toBe("Först: Åk till BL\u2011001 i dag.");
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
    expect(later.aside).toBe(`1${NBSP}titel utan inköpspris · 2${NBSP}235${NBSP}kr ej i vinsten.`);
    expect(later.aside).not.toContain("i risk");
  });

  it("skriver påfyllningar som besök och döljer nivåer utan punkter", () => {
    const page = buildPage(
      input([refill(M1, "soon", 1), refill(M2, "soon", 1)], { role: "refiller", economy: false }),
    );
    expect(page.header.title).toBe(`2${NBSP}besök att göra.`);
    expect(page.header.aside).toBe("Inget i dag.");
    expect(page.header.description).toBe("Först: Åk till BL\u2011001 snart.");
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

  it("räknar raderna överst (bokföring, ny automat) i rubriken: aldrig 'Inget att göra' bredvid dem", () => {
    const extras = extraTodos({ bokforingMonth: "oktober 2026", newMachines: 0 });
    const page = buildPage(input([], { extras }));
    expect(page.total).toBe(1);
    expect(page.header.title).toBe(`1${NBSP}sak att göra.`);
    expect(page.header.title).not.toMatch(/Inget/);
    expect(page.header.aside).toBe("Inget i dag.");
    expect(page.header.description).toBe("Först: Ladda ner bokföringen för oktober 2026.");
    expect(page.header.meta.find((m) => m.label === "Snart")?.value).toBe("1");
  });

  it("räknar extra rader tillsammans med reglernas punkter", () => {
    const extras = extraTodos({ bokforingMonth: "oktober 2026", newMachines: 2 });
    expect(extras.map((e) => e.title)).toEqual([
      `Välj butik för 2${NBSP}nya automater`,
      "Ladda ner bokföringen för oktober 2026",
    ]);
    const page = buildPage(input([refill(M1, "soon", 1)], { extras }));
    expect(page.total).toBe(3);
    // Inte "påfyllningar": det finns annat än påfyllningar.
    expect(page.header.title).toBe(`3${NBSP}saker att göra.`);
    expect(page.header.aside).toBe("1 i dag.");
    // Den nya automaten (i dag) går före påfyllningen (snart).
    expect(page.header.description).toBe("Först: Välj butik för 2\u00a0nya automater.");
  });

  it("Awish-kontot som går ut står först och räknas (brådskande = i dag)", () => {
    const text = "Awish-kontot går ut 18 apr. 2027 – förläng hos Awish";
    const soon = extraTodos({
      bokforingMonth: null,
      newMachines: 1,
      awishExpiry: { text, level: "soon" },
    });
    expect(soon.map((e) => [e.key, e.level])).toEqual([
      ["awish-expiry", "soon"],
      ["new-machines", "now"],
    ]);
    const urgent = extraTodos({
      bokforingMonth: null,
      newMachines: 0,
      awishExpiry: { text, level: "now" },
    });
    const page = buildPage(input([], { extras: urgent }));
    expect(page.total).toBe(1);
    expect(page.header.aside).toBe("1 i dag.");
    expect(page.header.description).toBe(`Först: ${text}.`);
    expect(extraTodos({ bokforingMonth: null, newMachines: 0, awishExpiry: null })).toEqual([]);
  });

  it("utan extra rader blir inget kvar", () => {
    expect(extraTodos({ bokforingMonth: null, newMachines: 0 })).toEqual([]);
    expect(extraTodos({ bokforingMonth: null, newMachines: 1 })[0]?.title).toBe(
      "Välj butik för den nya automaten",
    );
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
      capacity: null,
      batchSize: null,
      warehouseOnHand: 10,
      warehouseName: null,
      // Som Fyll på utan känd kapacitet: en veckas försäljning (36 på 14 d = 18) − 1 i automaten,
      // högst de 10 i lagret.
      suggested: 10,
      max: 500,
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
});

describe("påfyllningsrutan använder Fyll på-logiken", () => {
  const PLACE_A = "p-hemma";
  const PLACE_B = "p-kontoret";
  const sources = {
    places: [
      { id: PLACE_A, name: "Hemma" },
      { id: PLACE_B, name: "Kontoret" },
    ],
    stock: { [PLACE_A]: { [T1]: 40, [T2]: 14 }, [PLACE_B]: { [T1]: 3 } },
    machineSource: { [M2]: PLACE_B },
    defaultPlaceId: PLACE_A,
  };
  const action = (todo: TodoItem, over: Partial<ModelInput> = {}) => {
    const a = buildPage(input([todo], { sources, ...over })).groups[0]!.items[0]!.action;
    if (a?.kind !== "register-refill") throw new Error("ingen påfyllning");
    return a;
  };

  it("samma antal som Fyll på för samma automat och titel", () => {
    // Fack för 25, 1 i automaten, 40 hemma: Fyll på föreslår 24.
    const capacities = [{ machineId: M1, titleId: T1, capacity: 25 }];
    const a = action(refill(M1, "now", 1), { capacities });
    expect(a.suggested).toBe(suggestFill(1, 25, 40, 36, null));
    expect(a.suggested).toBe(24);
    expect(a.max).toBe(maxFill({ now: 1, capacity: 25 }));
    expect(a).toMatchObject({ capacity: 25, warehouseOnHand: 40, warehouseName: "Hemma" });
    // Samma rad i Fyll på (fillMachines) ger samma förslag.
    const [m] = fillMachines({
      machines: [
        {
          id: M1,
          code: "BL-001",
          name: "Automat 1",
          storeName: null,
          syncedAt: "2026-11-02T08:00:00Z",
          fill: [{ title_id: T1, units: 1, capacity: 25, channels: 1, empty: 0 }],
        },
      ],
      titles: new Map([[T1, "Titel 1"]]),
      machineStock: new Map([[pairKey(M1, T1), 1]]),
      home: new Map([[T1, 40]]),
      current: new Set([pairKey(M1, T1)]),
      retired: new Set(),
      sold: new Map([[pairKey(M1, T1), 36]]),
    });
    expect(m!.rows.find((r) => r.titleId === T1)?.suggested).toBe(a.suggested);
  });

  it("packen räknas mot lagret automaten fylls på från, inte summan av alla lager", () => {
    // BL-002 fylls på från Kontoret, som har 3 pack (Hemma har 40).
    const a = action(refill(M2, "now", 1), {
      capacities: [{ machineId: M2, titleId: T1, capacity: 25 }],
    });
    expect(a).toMatchObject({ warehouseOnHand: 3, warehouseName: "Kontoret", suggested: 3 });
    expect(refillHome({ sources, warehouse: null }, M1, T2)).toEqual({ onHand: 14, name: "Hemma" });
    expect(
      refillHome({ sources: { ...sources, defaultPlaceId: null }, warehouse: null }, M1, T1),
    ).toBeNull();
  });

  it("ett mystery-fack föreslår en hel omgång (14), aldrig 1", () => {
    const mystery = (onHand: number) =>
      item({
        ...refill(M1, "now", 1, onHand, T2),
        evidence: {
          ...refill(M1, "now", 1, onHand, T2).evidence,
          figures: [
            { key: "onHand", label: "I lager", value: onHand, unit: "packs" },
            { key: "batchSize", label: "Pack per omgång", value: 14, unit: "packs" },
          ],
        },
      });
    const titles = [
      { id: T1, name: "Titel 1" },
      { id: T2, name: "Mystery Pack", mysteryBatchSize: 14 },
    ];
    const capacities = [{ machineId: M1, titleId: T2, capacity: 20 }];
    // Tomt fack och en hel omgång hemma: 14.
    const empty = action(mystery(0), { titles, capacities });
    expect(empty).toMatchObject({ batchSize: 14, suggested: 14, max: 20 });
    // Pack kvar i facket: inget förslag (facket fylls bara på när det är tomt).
    expect(action(mystery(3), { titles, capacities }).suggested).toBe(0);
    // Mindre än en hel omgång hemma: inget förslag, aldrig en del av en omgång.
    const short = action(mystery(0), {
      titles,
      capacities,
      sources: { ...sources, stock: { [PLACE_A]: { [T2]: 13 } } },
    });
    expect(short.suggested).toBe(0);
    // Ett litet fack: en hel omgång går ändå att välja (som i Fyll på).
    expect(
      action(mystery(0), { titles, capacities: [{ machineId: M1, titleId: T2, capacity: 10 }] })
        .max,
    ).toBe(14);
  });

  it("taket är det som får plats i facket: ett större antal nekas", () => {
    const a = action(refill(M1, "now", 1, 20), {
      capacities: [{ machineId: M1, titleId: T1, capacity: 25 }],
    });
    expect(a.max).toBe(5);
    expect(a.suggested).toBe(5);
    // Utan känd kapacitet: Fyll på-stegarens tak (500), inte 10 000.
    expect(action(refill(M1, "now", 1)).max).toBe(500);
  });

  it("utan eget lager begränsar inget lager förslaget", () => {
    const a = action(refill(M1, "now", 1), {
      sources: null,
      warehouse: null,
      capacities: [{ machineId: M1, titleId: T1, capacity: 25 }],
    });
    expect(a).toMatchObject({ warehouseOnHand: null, suggested: 24 });
  });
});
