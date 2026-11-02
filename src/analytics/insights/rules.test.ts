import { describe, expect, it } from "vitest";
import { eachDay, type Period } from "@/domain";
import { daily, input, machine, many, title } from "../todos/test-helpers";
import type { AnalyticsOrder, TodoInput } from "../todos/types";
import {
  bestDayRule,
  compareLabel,
  computeInsights,
  concentrationRule,
  evaluateInsights,
  lossTitleRule,
  staleMachineRule,
  titleChangeRule,
  weekdayPatternRule,
} from "./index";
import type { Insight, InsightContext } from "./types";

const S = " ";
const WEEK: Period = { start: "2026-10-26", end: "2026-11-01" }; // mån–sön
const PREV: Period = { start: "2026-10-19", end: "2026-10-25" };

function ctx(i: TodoInput, period: Period = WEEK, compare: Period = PREV): InsightContext {
  const inRange = (p: Period) =>
    i.orders.filter((o) => o.businessDate >= p.start && o.businessDate <= p.end);
  const names = new Map([...i.titles, ...i.machines].map((x) => [x.id, x.name]));
  return {
    input: i,
    period,
    compare,
    orders: inRange(period),
    compareOrders: inRange(compare),
    titleName: (id) => names.get(id) ?? id,
    machineName: (id) => names.get(id) ?? id,
  };
}

/** `n` order för titeln, utspridda över periodens dagar. */
function spread(
  titleId: string,
  n: number,
  period: Period = WEEK,
  machineId = "m1",
): AnalyticsOrder[] {
  const days = eachDay(period.start, period.end);
  return Array.from(
    { length: n },
    (_, k) => many(1, { titleId, machineId, businessDate: days[k % days.length]! })[0]!,
  );
}

describe("koncentration", () => {
  const titles = [
    title("a", "30th Celebration"),
    title("b", "B"),
    title("c", "C"),
    title("d", "D"),
  ];

  it("slår till när en titel står för minst 25 % av intäkten", () => {
    const i = input({
      titles,
      orders: [...spread("a", 33), ...spread("b", 30), ...spread("c", 20), ...spread("d", 17)],
    });
    const [r, ...rest] = concentrationRule(ctx(i));
    expect(rest).toHaveLength(0);
    expect(r).toMatchObject({
      key: "concentration:a",
      text: `30th Celebration står för 33${S}% av intäkten`,
      detail: `1${S}617${S}kr av 4${S}900${S}kr och 33${S}order av 100${S}order 26${S}okt.${S}–${S}1${S}nov.`,
      score: 4_000 + 160,
      link: "/lonsamhet?grupp=titel&fran=2026-10-26&till=2026-11-01",
    });
    expect(r?.evidence.orderIds).toHaveLength(33);
    expect(r?.evidence.figures.find((f) => f.key === "shareBp")?.value).toBe(3_300);
  });

  it("slår inte till vid jämn fördelning, för få titlar eller för få order", () => {
    const even = input({
      titles,
      orders: ["a", "b", "c", "d"].flatMap((t) => spread(t, 10)).concat(spread("x", 10)),
    });
    expect(concentrationRule(ctx(even))).toHaveLength(0); // 20 % var
    const two = input({ titles, orders: [...spread("a", 30), ...spread("b", 30)] });
    expect(concentrationRule(ctx(two))).toHaveLength(0);
    const few = input({
      titles,
      orders: [...spread("a", 10), ...spread("b", 5), ...spread("c", 4)],
    });
    expect(concentrationRule(ctx(few))).toHaveLength(0);
  });

  it("räknar bara periodens order", () => {
    const i = input({
      titles,
      orders: [
        ...spread("a", 20, PREV),
        ...spread("b", 10),
        ...spread("c", 10),
        ...spread("d", 10),
      ],
    });
    const [r] = concentrationRule(ctx(i)); // a:s order förra veckan räknas inte
    expect(r?.key).toBe("concentration:b");
    expect(r?.evidence.figures.find((f) => f.key === "totalOrders")?.value).toBe(30);
  });
});

describe("stillastående automat", () => {
  const machines = [machine("m3", "Automat 3"), machine("m4", "Automat 4")];

  it("slår till när en automat som brukar sälja inte sålt på 2 dagar", () => {
    const i = input({ machines, orders: daily("t1", "m3", "2026-10-17", 14, 3) }); // t.o.m. 30 okt.
    const [r] = staleMachineRule(ctx(i));
    expect(r).toMatchObject({
      key: "stale-machine:m3",
      tone: "negative",
      text: `Automat 3 har inte sålt på 2${S}dagar`,
      detail: `Senaste försäljning 30${S}okt. Den brukar sälja 3,0 pack per dag, så ca 6${S}pack har uteblivit.`,
      score: 8_060,
      link: "/automater/m3?fran=2026-10-26&till=2026-11-01",
    });
    expect(r?.evidence.dates).toEqual(["2026-10-31", "2026-11-01"]);
  });

  it("slår inte till för en långsam automat, efter 1 dag eller för automater ur drift", () => {
    const slow = input({
      machines,
      orders: daily("t1", "m3", "2026-10-17", 14, 0).concat(
        many(2, { titleId: "t1", machineId: "m3", businessDate: "2026-10-30" }),
      ),
    });
    expect(staleMachineRule(ctx(slow))).toHaveLength(0); // 2 pack på 14 dagar → 0,3 uteblivna
    const recent = input({ machines, orders: daily("t1", "m3", "2026-10-18", 14, 3) }); // t.o.m. 31 okt.
    expect(staleMachineRule(ctx(recent))).toHaveLength(0);
    const off = input({
      machines: [machine("m3", "Automat 3", { activeTo: "2026-10-30" })],
      orders: daily("t1", "m3", "2026-10-17", 14, 3),
    });
    expect(staleMachineRule(ctx(off))).toHaveLength(0);
  });

  it("order efter periodens slut räknas inte", () => {
    const i = input({
      machines,
      orders: [
        ...daily("t1", "m3", "2026-10-17", 14, 3),
        ...many(1, { titleId: "t1", machineId: "m3", businessDate: "2026-11-02" }),
      ],
    });
    expect(staleMachineRule(ctx(i))).toHaveLength(1);
  });
});

describe("ökning och minskning per titel", () => {
  const titles = [title("mp", "Mystery Pack"), title("bb", "Black Bolt")];

  it("Mystery Pack säljer 40 % mer än förra veckan", () => {
    const i = input({ titles, orders: [...spread("mp", 20, PREV), ...spread("mp", 28)] });
    const [r, ...rest] = titleChangeRule(ctx(i));
    expect(rest).toHaveLength(0);
    expect(r).toMatchObject({
      key: "title-up:mp",
      kind: "title-up",
      tone: "positive",
      text: `Mystery Pack säljer 40${S}% mer än förra veckan`,
      detail: `28${S}pack mot 20${S}pack (26${S}okt.${S}–${S}1${S}nov. mot 19–25${S}okt.).`,
      score: 5_000 + 800 + 48,
    });
    expect(r?.evidence.orderIds).toHaveLength(48);
  });

  it("minskning blir en egen kandidat", () => {
    const i = input({
      titles,
      orders: [
        ...spread("mp", 20, PREV),
        ...spread("mp", 28),
        ...spread("bb", 20, PREV),
        ...spread("bb", 12),
      ],
    });
    const rs = titleChangeRule(ctx(i));
    expect(rs.map((r) => r.key)).toEqual(["title-up:mp", "title-down:bb"]);
    expect(rs[1]?.text).toBe(`Black Bolt säljer 40${S}% mindre än förra veckan`);
  });

  it("för liten volym, för liten förändring eller för få pack ger inget", () => {
    const low = input({ titles, orders: [...spread("mp", 8, PREV), ...spread("mp", 16)] });
    expect(titleChangeRule(ctx(low))).toHaveLength(0); // under 10 pack förra veckan
    const small = input({ titles, orders: [...spread("mp", 20, PREV), ...spread("mp", 24)] });
    expect(titleChangeRule(ctx(small))).toHaveLength(0); // +20 %
    const fewUnits = input({ titles, orders: [...spread("mp", 10, PREV), ...spread("mp", 14)] });
    expect(titleChangeRule(ctx(fewUnits))).toHaveLength(0); // +40 % men bara 4 pack
    const gone = input({ titles, orders: spread("mp", 12, PREV) });
    expect(titleChangeRule(ctx(gone))[0]?.text).toBe(
      `Mystery Pack säljer 100${S}% mindre än förra veckan`,
    );
  });

  it("olika långa perioder jämförs per dag", () => {
    const compare: Period = { start: "2026-10-12", end: "2026-10-25" }; // 14 dagar
    const i = input({ titles, orders: [...spread("mp", 40, compare), ...spread("mp", 28)] });
    const [r] = titleChangeRule(ctx(i, WEEK, compare));
    expect(r?.text).toBe(`Mystery Pack säljer 40${S}% mer än 12–25${S}okt.`);
    expect(r?.detail).toContain("räknat per dag");
  });

  it("compareLabel", () => {
    expect(compareLabel(WEEK, PREV)).toBe("förra veckan");
    expect(
      compareLabel(
        { start: "2026-10-01", end: "2026-10-31" },
        { start: "2026-09-01", end: "2026-09-30" },
      ),
    ).toBe("förra månaden");
    expect(compareLabel(WEEK, { start: "2025-10-27", end: "2025-11-02" })).toBe(
      `27${S}okt.${S}–${S}2${S}nov.`,
    );
  });
});

describe("bästa dag", () => {
  it("slår till när bästa dagen gav minst 1,5 gånger en snittdag", () => {
    const orders = eachDay(WEEK.start, WEEK.end).flatMap((d) =>
      many(d === "2026-10-31" ? 10 : 2, { titleId: "t1", businessDate: d }),
    );
    const [r] = bestDayRule(ctx(input({ orders })));
    expect(r).toMatchObject({
      key: "best-day:2026-10-31",
      tone: "positive",
      text: `Lördag 31${S}okt. var bästa dagen med 490${S}kr`,
      detail: `3,2 gånger en genomsnittlig dag (154${S}kr) 26${S}okt.${S}–${S}1${S}nov., 10${S}order.`,
      link: "/forsaljning?fran=2026-10-31&till=2026-10-31",
    });
    expect(r?.evidence.orderIds).toHaveLength(10);
  });

  it("jämn försäljning, få order eller kort period ger inget", () => {
    const even = eachDay(WEEK.start, WEEK.end).flatMap((d) =>
      many(3, { titleId: "t1", businessDate: d }),
    );
    expect(bestDayRule(ctx(input({ orders: even })))).toHaveLength(0);
    const few = eachDay(WEEK.start, WEEK.end).flatMap((d) =>
      many(d === "2026-10-31" ? 4 : 1, { titleId: "t1", businessDate: d }),
    );
    expect(bestDayRule(ctx(input({ orders: few })))).toHaveLength(0);
    const short: Period = { start: "2026-10-30", end: "2026-11-01" };
    const spike = many(10, { titleId: "t1", businessDate: "2026-10-31" });
    expect(bestDayRule(ctx(input({ orders: spike }), short, PREV))).toHaveLength(0);
    expect(bestDayRule(ctx(input()))).toHaveLength(0);
  });

  it("vid lika väljs den tidigaste dagen", () => {
    const orders = [
      ...many(10, { titleId: "t1", businessDate: "2026-10-31" }),
      ...many(10, { titleId: "t1", businessDate: "2026-10-27" }),
    ];
    expect(bestDayRule(ctx(input({ orders })))[0]?.key).toBe("best-day:2026-10-27");
  });
});

describe("veckodagsmönster", () => {
  const FOUR_WEEKS: Period = { start: "2026-10-05", end: "2026-11-01" };

  it("Lördagar ger mer intäkt än en genomsnittlig dag", () => {
    const orders = eachDay(FOUR_WEEKS.start, FOUR_WEEKS.end).flatMap((d) =>
      many(["2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31"].includes(d) ? 6 : 2, {
        titleId: "t1",
        businessDate: d,
      }),
    );
    const [r] = weekdayPatternRule(ctx(input({ orders }), FOUR_WEEKS));
    expect(r).toMatchObject({
      key: "weekday-pattern:6",
      text: `Lördagar ger 133${S}% mer intäkt än en genomsnittlig dag`,
      detail: `Snitt 294${S}kr per lördag mot 126${S}kr per dag 5${S}okt.${S}–${S}1${S}nov. (4${S}lördagar).`,
    });
    expect(r?.evidence.dates).toEqual(["2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31"]);
  });

  it("jämn vecka, kort period eller få order ger inget", () => {
    const even = eachDay(FOUR_WEEKS.start, FOUR_WEEKS.end).flatMap((d) =>
      many(2, { titleId: "t1", businessDate: d }),
    );
    expect(weekdayPatternRule(ctx(input({ orders: even }), FOUR_WEEKS))).toHaveLength(0);
    const twoWeeks: Period = { start: "2026-10-19", end: "2026-11-01" };
    const sat = eachDay(twoWeeks.start, twoWeeks.end).flatMap((d) =>
      many(d === "2026-10-24" || d === "2026-10-31" ? 20 : 3, { titleId: "t1", businessDate: d }),
    );
    expect(weekdayPatternRule(ctx(input({ orders: sat }), twoWeeks))).toHaveLength(0);
    const few = many(30, { titleId: "t1", businessDate: "2026-10-31" });
    expect(weekdayPatternRule(ctx(input({ orders: few }), FOUR_WEEKS))).toHaveLength(0);
  });
});

describe("titel med förlust", () => {
  const titles = [title("bb", "Black Bolt"), title("mp", "Mystery Pack")];
  const price = (titleId: string, unitCostOre: number) => ({
    titleId,
    unitCostOre,
    validFrom: "2026-01-01",
  });

  it("Black Bolt går med förlust per pack (provision 10 %)", () => {
    const i = input({ titles, orders: spread("bb", 5), prices: [price("bb", 4_500)] });
    const [r] = lossTitleRule(ctx(i));
    expect(r).toMatchObject({
      key: "loss-title:bb",
      tone: "negative",
      score: 9_005,
      text: `Black Bolt går med förlust: −0,90${S}kr per pack`,
      detail: `Snittpris 49,00${S}kr, inköpspris 45,00${S}kr, provision 4,90${S}kr per pack (5${S}order 26${S}okt.${S}–${S}1${S}nov.).`,
      link: "/inkopspriser?titel=bb",
    });
    expect(r?.evidence.figures.find((f) => f.key === "leftPerOrderOre")?.value).toBe(-90);
  });

  it("noll kvar räknas som förlustvarning, lönsam titel och få order inte", () => {
    const zero = input({ titles, orders: spread("bb", 5), prices: [price("bb", 4_410)] });
    expect(lossTitleRule(ctx(zero))[0]?.text).toBe(
      `Black Bolt går jämnt ut: 0,00${S}kr kvar per pack`,
    );
    const ok = input({ titles, orders: spread("bb", 5), prices: [price("bb", 3_000)] });
    expect(lossTitleRule(ctx(ok))).toHaveLength(0);
    const few = input({ titles, orders: spread("bb", 2), prices: [price("bb", 4_500)] });
    expect(lossTitleRule(ctx(few))).toHaveLength(0);
    const noPrice = input({ titles, orders: spread("bb", 5) });
    expect(lossTitleRule(ctx(noPrice))).toHaveLength(0);
  });

  it("väljer titeln med störst total förlust", () => {
    const i = input({
      titles,
      orders: [...spread("bb", 5), ...spread("mp", 20)],
      prices: [price("bb", 5_000), price("mp", 4_800)], // −5,90 × 5 = −29,50; −3,90 × 20 = −78,00
    });
    expect(lossTitleRule(ctx(i))[0]?.key).toBe("loss-title:mp");
  });
});

describe("computeInsights", () => {
  function rich(): TodoInput {
    const titles = [
      title("a", "30th Celebration"),
      title("mp", "Mystery Pack"),
      title("c", "C"),
      title("bb", "Black Bolt"),
    ];
    return input({
      titles,
      machines: [machine("m1", "Automat 1"), machine("m3", "Automat 3")],
      orders: [
        ...spread("a", 40),
        ...spread("mp", 20, PREV),
        ...spread("mp", 28),
        ...spread("c", 20),
        ...spread("bb", 5),
        ...daily("c", "m3", "2026-10-17", 14, 3),
        ...many(15, { titleId: "a", businessDate: "2026-10-31" }),
      ],
      prices: [{ titleId: "bb", unitCostOre: 4_500, validFrom: "2026-01-01" }],
    });
  }
  const DATA = rich();

  it("väljer högst 4, en per regel, högst poäng först", () => {
    const all = evaluateInsights(DATA, WEEK);
    const chosen = computeInsights(DATA, WEEK);
    expect(all.length).toBeGreaterThan(4);
    expect(chosen.map((r) => r.kind)).toEqual([
      "loss-title",
      "stale-machine",
      "title-up",
      "concentration",
    ]);
    expect(new Set(chosen.map((r) => r.kind)).size).toBe(chosen.length);
    const scores = chosen.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("jämförelseperioden är som standard föregående lika långa period", () => {
    expect(computeInsights(DATA, WEEK)).toEqual(computeInsights(DATA, WEEK, PREV));
    expect(computeInsights(DATA, WEEK, null)).toEqual(computeInsights(DATA, WEEK, PREV));
  });

  it("maxCount och tomt resultat", () => {
    expect(computeInsights(DATA, WEEK, null, { maxCount: 2 })).toHaveLength(2);
    expect(computeInsights(input(), WEEK)).toEqual([]);
  });

  it("deterministisk och oberoende av ordningen i indata", () => {
    const reversed = {
      ...DATA,
      orders: [...DATA.orders].reverse(),
      titles: [...DATA.titles].reverse(),
    };
    expect(computeInsights(reversed, WEEK)).toEqual(computeInsights(DATA, WEEK));
  });

  it("avvisar ogiltig period", () => {
    expect(() => computeInsights(DATA, { start: "2026-11-01", end: "2026-10-01" })).toThrow();
    expect(() => computeInsights(DATA, { start: "2026-02-30", end: "2026-03-01" })).toThrow();
  });

  it("varje iakttagelse har text, underlag och länk", () => {
    for (const r of evaluateInsights(DATA, WEEK) as Insight[]) {
      expect(r.text).not.toMatch(/\.\./);
      expect(r.detail).not.toMatch(/\.\./);
      expect(r.evidence.rule.length).toBeGreaterThan(0);
      expect(r.link.startsWith("/")).toBe(true);
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(10_000);
    }
  });
});
