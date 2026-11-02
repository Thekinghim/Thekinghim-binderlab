import { describe, expect, it } from "vitest";
import type { Period } from "@/domain";
import { daily, input, machine, many, title } from "../todos/test-helpers";
import { computeInsights, evaluateInsights, periodSummaryRule, topTitleRule } from "./index";

const NOW = "2026-11-02T10:00:00Z"; // mån 2 nov. 11:00 svensk tid
const WEEK: Period = { start: "2026-10-26", end: "2026-11-01" };
const plain = (s: string) => s.replace(/ /g, " ");
const texts = (list: { text: string }[]) => list.map((i) => plain(i.text));

describe("perioder som når in i dag eller framtiden (options.now)", () => {
  // Automat 1 säljer Mystery Pack 2 per dag 1 okt.–2 nov. Sidan ber om hela november.
  const data = input({
    titles: [title("tM", "Mystery Pack")],
    machines: [machine("m1", "Automat 1")],
    orders: daily("tM", "m1", "2026-10-01", 33, 2),
  });
  const NOV: Period = { start: "2026-11-01", end: "2026-11-30" };

  it("utan now räknas framtida dagar som tysta (därför ska sidan alltid skicka now)", () => {
    const all = texts(evaluateInsights(data, NOV));
    expect(all).toContain("Automat 1 har inte sålt på 28 dagar");
    expect(all).toContain("Mystery Pack säljer 93 % mindre än förra månaden");
  });

  it("med now kortas perioden till i går: ingen falsk tystnad eller minskning", () => {
    const all = evaluateInsights(data, NOV, null, { now: NOW });
    expect(all.some((i) => i.kind === "stale-machine")).toBe(false);
    expect(all.some((i) => i.kind === "title-down" || i.kind === "title-up")).toBe(false);
    const summary = all.find((i) => i.kind === "period-summary");
    expect(summary?.evidence.period).toEqual({ start: "2026-11-01", end: "2026-11-01" });
    expect(plain(summary?.text ?? "")).toBe("Intäkten var 98 kr, lika mycket som förra månaden");
    expect(plain(summary?.detail ?? "")).toContain("räknat per dag");
  });

  it("perioden börjar i dag eller senare: inga iakttagelser", () => {
    expect(
      computeInsights(data, { start: "2026-11-02", end: "2026-11-08" }, null, { now: NOW }),
    ).toEqual([]);
    expect(
      computeInsights(data, { start: "2026-12-01", end: "2026-12-31" }, null, { now: NOW }),
    ).toEqual([]);
  });

  it("en period helt bakåt i tiden ändras inte", () => {
    expect(evaluateInsights(data, WEEK, null, { now: NOW })).toEqual(evaluateInsights(data, WEEK));
  });

  it("stillastående automat: försäljning efter periodens slut gör att regeln inte slår till", () => {
    // 3 per dag 10–23 okt., tyst 24 okt.–31 okt., sålde igen 1 nov.
    const resumed = input({
      titles: [title("a", "A")],
      machines: [machine("m1", "Automat 1")],
      orders: [...daily("a", "m1", "2026-10-10", 14, 3), ...daily("a", "m1", "2026-11-01", 1, 1)],
    });
    const P: Period = { start: "2026-10-19", end: "2026-10-25" };
    const stale = (opts = {}) =>
      evaluateInsights(resumed, P, null, opts).filter((i) => i.kind === "stale-machine");
    expect(texts(stale())).toEqual(["Automat 1 har inte sålt på 2 dagar"]);
    expect(stale({ now: NOW })).toEqual([]);
  });

  it("now som Date, ms eller sträng ger samma resultat; tidszonen för now kan anges", () => {
    const a = evaluateInsights(data, NOV, null, { now: NOW });
    expect(evaluateInsights(data, NOV, null, { now: new Date(NOW) })).toEqual(a);
    expect(evaluateInsights(data, NOV, null, { now: Date.parse(NOW) })).toEqual(a);
    // 2 nov. 01:00 svensk tid är fortfarande 1 nov. i Los Angeles: då finns inga hela dagar i november.
    const early = "2026-11-02T00:00:00Z";
    expect(
      evaluateInsights(data, NOV, null, { now: early, timeZone: "America/Los_Angeles" }),
    ).toEqual([]);
  });
});

describe("urval: 3–4 iakttagelser", () => {
  it("fyller på till 3 med en andra kandidat från samma regel", () => {
    // Två automater som sålt 3 per dag från 10 okt. (till 23 resp. 21 okt.) och sedan inget: två stillastående automater
    // och ingen försäljning i perioden.
    const i = input({
      titles: [title("a", "A"), title("b", "B")],
      machines: [machine("m1", "Automat 1"), machine("m2", "Automat 2")],
      placements: [
        { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
        { machineId: "m2", storeId: "s1", from: "2026-01-01", to: null },
      ],
      orders: [...daily("a", "m1", "2026-10-10", 14, 3), ...daily("b", "m2", "2026-10-10", 12, 3)],
    });
    const empty: Period = { start: "2026-01-05", end: "2026-01-11" }; // utan försäljning
    const shown = computeInsights(i, WEEK, empty);
    expect(shown.map((x) => x.kind)).toEqual(["stale-machine", "stale-machine", "period-summary"]);
    expect(texts(shown)).toEqual([
      "Automat 2 har inte sålt på 11 dagar",
      "Automat 1 har inte sålt på 9 dagar",
      "Ingen försäljning 26 okt. – 1 nov.",
    ]);
  });

  it("utfyllnaden visas inte när fyra starkare regler slår till", () => {
    const i = input({ titles: [title("a", "A"), title("b", "B")], orders: [] });
    expect(computeInsights(i, WEEK, null, { maxCount: 1 })).toHaveLength(1);
    expect(computeInsights(i, WEEK, null, { maxCount: 4, minCount: 0 })).toHaveLength(1);
  });

  it("mest sålda titel visas inte när koncentration redan säger samma sak", () => {
    const i = input({
      titles: [title("a", "30th Celebration"), title("b", "B"), title("c", "C")],
      orders: [
        ...many(10, { titleId: "a", businessDate: "2026-10-27" }),
        ...many(5, { titleId: "b", businessDate: "2026-10-28" }),
        ...many(5, { titleId: "c", businessDate: "2026-10-29" }),
      ],
    });
    const kinds = computeInsights(i, WEEK).map((x) => x.kind);
    expect(kinds).toContain("concentration");
    expect(kinds).not.toContain("top-title");
  });

  it("resultatet är sorterat på poäng", () => {
    const i = input({
      titles: [title("a", "A"), title("b", "B")],
      orders: [...daily("a", "m1", "2026-10-26", 3, 2), ...daily("b", "m1", "2026-10-29", 2, 2)],
    });
    const shown = computeInsights(i, WEEK);
    const scores = shown.map((x) => x.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    expect(shown.map((x) => x.kind)).toEqual(["period-summary", "top-title"]);
  });
});

describe("utfyllnadsregler", () => {
  const ctxFor = (orders: ReturnType<typeof many>, period: Period = WEEK) => {
    const i = input({ titles: [title("a", "Mystery Pack"), title("b", "Black Bolt")], orders });
    const compare: Period = { start: "2026-10-19", end: "2026-10-25" };
    const inRange = (p: Period) =>
      orders.filter((o) => o.businessDate >= p.start && o.businessDate <= p.end);
    const names = new Map(i.titles.map((t) => [t.id, t.name]));
    return {
      input: i,
      period,
      compare,
      requestedPeriod: period,
      requestedCompare: compare,
      dataEnd: period.end,
      orders: inRange(period),
      compareOrders: inRange(compare),
      titleName: (id: string) => names.get(id) ?? id,
      machineName: (id: string) => id,
    };
  };

  it("intäkt i perioden: ökning mot förra veckan", () => {
    const c = ctxFor([
      ...many(12, { titleId: "a", businessDate: "2026-10-27" }),
      ...many(10, { titleId: "a", businessDate: "2026-10-20" }),
    ]);
    const [s] = periodSummaryRule(c);
    expect(plain(s?.text ?? "")).toBe("Intäkten var 588 kr, 20 % mer än förra veckan");
    expect(plain(s?.detail ?? "")).toBe(
      "12 order 26 okt. – 1 nov. mot 490 kr och 10 order 19–25 okt.",
    );
    expect(s?.score).toBe(1_200);
    expect(s?.tone).toBe("positive");
    expect(s?.evidence.orderIds).toHaveLength(12);
  });

  it("intäkt i perioden: ingen jämförelse när förra perioden saknar försäljning", () => {
    const [s] = periodSummaryRule(ctxFor(many(3, { titleId: "a", businessDate: "2026-10-27" })));
    expect(plain(s?.text ?? "")).toBe("Intäkten var 147 kr");
    expect(s?.tone).toBe("neutral");
    expect(s?.score).toBe(1_000);
  });

  it("mest sålda titel: slår till med 2 titlar, inte med 1", () => {
    const two = topTitleRule(
      ctxFor([
        ...many(6, { titleId: "a", businessDate: "2026-10-27" }),
        ...many(4, { titleId: "b", businessDate: "2026-10-28" }),
      ]),
    );
    expect(texts(two)).toEqual(["Mystery Pack sålde mest: 6 pack och 294 kr (60 % av intäkten)"]);
    expect(two[0]?.score).toBe(800);
    expect(topTitleRule(ctxFor(many(6, { titleId: "a", businessDate: "2026-10-27" })))).toEqual([]);
  });
});
