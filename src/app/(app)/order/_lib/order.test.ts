/**
 * Orderlistans rena delar: URL-parametrar, sökord, namnmatchning och ordning, rubriken
 * och CSV-exporten.
 */

import { describe, expect, it } from "vitest";

import { formatCsvNumber } from "@/lib/format";

import {
  csvKronor,
  csvTime,
  csvTimeFormatter,
  orderCsv,
  orderCsvColumns,
  orderCsvFileName,
  orderCsvPart,
} from "./csv";
import { comparePhrase, orderHeadline, sentence, type HeadlineInput } from "./headline";
import {
  cleanQuery,
  DEFAULT_SORT,
  hasPageFilter,
  likePattern,
  listSignature,
  lockedListQuery,
  parseOrderParams,
  searchTerms,
  withOrderParams,
} from "./params";
import { buildRefs, matchTerms, rankMap, sortRanks, titleChoices } from "./refs";
import { isTestPurchase, testPurchaseNote } from "./test-purchase";
import { providerNote } from "../_components/order-detail";
import type { OrderRefs, OrderRow } from "./types";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";
const M1 = "44444444-4444-4444-8444-444444444444";
const M2 = "55555555-5555-4555-8555-555555555555";
const S1 = "66666666-6666-4666-8666-666666666666";

describe("parseOrderParams", () => {
  it("ger standardvärden utan parametrar", () => {
    expect(parseOrderParams({})).toEqual({
      q: "",
      titleId: null,
      sort: DEFAULT_SORT,
      orderId: null,
    });
  });

  it("läser sökning, titel, sortering och order", () => {
    const p = parseOrderParams({
      q: "  mystery   bl-002 ",
      titel: T1.toUpperCase(),
      sortera: "belopp",
      ordning: "stigande",
      order: T2,
    });
    expect(p).toEqual({
      q: "mystery bl-002",
      titleId: T1,
      sort: { key: "belopp", dir: "asc" },
      orderId: T2,
    });
  });

  it("tål skräp: okänd sortering, ogiltiga id och för lång sökning", () => {
    const p = parseOrderParams({
      q: "x".repeat(500),
      titel: "inte-ett-id",
      sortera: "drop table",
      ordning: "baklänges",
      order: "1; select",
    });
    expect(p.q).toHaveLength(100);
    expect(p.titleId).toBeNull();
    expect(p.orderId).toBeNull();
    expect(p.sort).toEqual(DEFAULT_SORT);
  });

  it("ger textkolumner stigande och tal fallande som första riktning", () => {
    expect(parseOrderParams({ sortera: "titel" }).sort).toEqual({ key: "titel", dir: "asc" });
    expect(parseOrderParams({ sortera: "belopp" }).sort).toEqual({ key: "belopp", dir: "desc" });
  });

  it("tar första värdet när parametern förekommer flera gånger", () => {
    expect(parseOrderParams({ q: ["a", "b"] }).q).toBe("a");
  });
});

describe("withOrderParams", () => {
  it("skriver inte ut standardvärden och behåller skalets parametrar", () => {
    const next = withOrderParams(
      { period: "allt", butik: S1, q: "gammal", sortera: "titel" },
      { q: "", sort: DEFAULT_SORT },
    );
    expect(next.toString()).toBe(`period=allt&butik=${S1}`);
  });

  it("går fram och tillbaka utan förlust", () => {
    const patch = {
      q: "151",
      titleId: T1,
      sort: { key: "tid", dir: "asc" } as const,
      orderId: T2,
    };
    const parsed = parseOrderParams(withOrderParams({}, patch));
    expect(parsed).toEqual({ q: "151", titleId: T1, sort: patch.sort, orderId: T2 });
  });

  it("skriver bara ut riktningen när den inte är kolumnens första", () => {
    expect(withOrderParams({}, { sort: { key: "belopp", dir: "desc" } }).toString()).toBe(
      "sortera=belopp",
    );
    expect(withOrderParams({}, { sort: { key: "titel", dir: "desc" } }).toString()).toBe(
      "sortera=titel&ordning=fallande",
    );
  });

  it("ignorerar ogiltiga id", () => {
    expect(withOrderParams({}, { titleId: "x", orderId: "y" }).toString()).toBe("");
  });
});

describe("listSignature", () => {
  it("bortser från detaljvyn och parametrarnas ordning", () => {
    expect(listSignature({ q: "a", period: "7d", order: T1 })).toBe(
      listSignature({ period: "7d", q: "a" }),
    );
  });
});

describe("lockedListQuery", () => {
  it("låser en relativ period till datum och tar bort detaljvyn", () => {
    const q = lockedListQuery(new URLSearchParams(`period=30d&butik=${S1}&q=mystery&order=${T1}`), {
      start: "2026-10-03",
      end: "2026-11-01",
    });
    const sp = new URLSearchParams(q);
    expect(sp.get("period")).toBeNull();
    expect(sp.get("from")).toBe("2026-10-03");
    expect(sp.get("to")).toBe("2026-11-01");
    expect(sp.get("butik")).toBe(S1);
    expect(sp.get("q")).toBe("mystery");
    expect(sp.get("order")).toBeNull();
  });
});

describe("detaljvyns datakälla", () => {
  it("upprepar inte providern när namnet redan säger den", () => {
    expect(providerNote("Awish (CSV)", "awish_csv")).toBeNull();
    expect(providerNote("Awish", "awish_csv")).toBe("Awish, CSV-fil");
    expect(providerNote("Kassasystem", "awish_grpc")).toBe("Awish, API");
  });
});

describe("sökord", () => {
  it("delar på mellanslag, tar bort dubbletter och kapar efter sex ord", () => {
    expect(searchTerms(" Mystery  mystery BL-002 ")).toEqual(["Mystery", "BL-002"]);
    expect(searchTerms("a b c d e f g h")).toHaveLength(6);
    expect(cleanQuery(null)).toBe("");
    expect(hasPageFilter(parseOrderParams({ q: "x" }))).toBe(true);
    expect(hasPageFilter(parseOrderParams({ period: "7d" }))).toBe(false);
  });

  it("gör %, _ och \\ i söktexten till vanliga tecken i ILIKE", () => {
    expect(likePattern("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
  });
});

const refs: OrderRefs = buildRefs({
  titles: [
    { id: T1, name: "Pokémon 151", archived: false },
    { id: T2, name: "Ascended Heroes", archived: false },
    { id: T3, name: "Äventyr", archived: true },
  ],
  machines: [
    { id: M2, code: "BL-010", name: "Gallerian" },
    { id: M1, code: "BL-002", name: "Centrum" },
  ],
  stores: [{ id: S1, name: "Åhléns City" }],
});

describe("refs", () => {
  it("sorterar namn i svensk ordning (å ä ö sist) och koder numeriskt", () => {
    expect(refs.titles.map((t) => t.name)).toEqual(["Ascended Heroes", "Pokémon 151", "Äventyr"]);
    expect(refs.machines.map((m) => m.code)).toEqual(["BL-002", "BL-010"]);
    expect(sortRanks(refs).titles).toEqual([T2, T1, T3]);
    expect(rankMap(refs.titles).get(T1)).toBe(1);
  });

  it("matchar sökord mot namn utan hänsyn till versaler och accenter (utom å ä ö)", () => {
    const [pokemon, centrum, ahlens, a] = matchTerms(["pokemon", "centrum", "åhl", "a"], refs);
    expect(pokemon?.titleIds).toEqual([T1]);
    expect(centrum?.machineIds).toEqual([M1]);
    expect(ahlens?.storeIds).toEqual([S1]);
    // "a" träffar inte "Ä" eller "Å".
    expect(a?.titleIds).toEqual([T2]);
    expect(a?.storeIds).toEqual([]);
  });

  it("visar arkiverade titlar i filtret bara när de är valda", () => {
    expect(titleChoices(refs.titles, null).map((t) => t.id)).toEqual([T2, T1]);
    expect(titleChoices(refs.titles, T3).map((t) => t.id)).toEqual([T2, T1, T3]);
  });
});

const base: HeadlineInput = {
  totals: { count: 460, amountOre: 7_998_700 },
  compareTotals: { count: 400, amountOre: 7_141_700 },
  period: { start: "2026-10-13", end: "2026-11-01" },
  compare: { start: "2026-09-23", end: "2026-10-12" },
  days: 20,
  periodKey: "eget",
  hasOrders: true,
  latestOrderAt: "2026-11-01T16:17:00.000Z",
  dataStart: "2026-01-01",
  filtered: false,
  timeZone: "Europe/Stockholm",
  now: new Date("2026-11-02T09:00:00Z"),
};

/** Hårda mellanslag som vanliga, för läsbara förväntningar (format.ts testar dem). */
const plain = (s: string | null) => (s ?? "").replace(/\u00A0/g, " ");
const plainH = (h: { title: string; aside: string }) => ({
  title: plain(h.title),
  aside: plain(h.aside),
});

describe("orderHeadline", () => {
  it("ger antal, dagar, betalt belopp och förändring mot jämförelseperioden", () => {
    expect(plainH(orderHeadline(base))).toEqual({
      title: `460 order på 20 dagar.`,
      aside: `79 987 kr betalt, 12 % mer än 23 sep. –\u2060 12 okt.`,
    });
  });

  it("skriver minskning med en decimal under 10 % och ingen extra punkt efter förkortning", () => {
    const phrase = comparePhrase({ ...base, compareTotals: { count: 1, amountOre: 8_500_000 } });
    expect(plain(phrase)).toBe(`5,9 % mindre än 23 sep. –\u2060 12 okt.`);
    expect(sentence("12 okt.")).toBe("12 okt.");
    expect(sentence("12 okt")).toBe("12 okt.");
  });

  it("nämner första ordern när jämförelseperioden ligger före den", () => {
    // 30 dagar (3 okt.–1 nov.), första ordern 13 okt.: jämförelseperioden saknar data.
    const h = orderHeadline({
      ...base,
      period: { start: "2026-10-03", end: "2026-11-01" },
      compare: { start: "2026-09-03", end: "2026-10-02" },
      days: 30,
      dataStart: "2026-10-13",
      compareTotals: { count: 0, amountOre: 0 },
    });
    expect(plain(h.aside)).toBe(`79 987 kr betalt, första ordern kom 13 okt.`);
    // Dagarna räknas från första ordern t.o.m. senaste dagen med order, som på Automater.
    expect(plain(h.title)).toBe(`460 order på 20 dagar.`);
    // Perioden slutar i dag och dagens order har kommit: i dag räknas med.
    const today = orderHeadline({
      ...base,
      period: { start: "2026-10-03", end: "2026-11-02" },
      days: 31,
      dataStart: "2026-10-13",
      latestOrderAt: "2026-11-02T08:00:00.000Z",
      compareTotals: { count: 0, amountOre: 0 },
    });
    expect(plain(today.title)).toBe(`460 order på 21 dagar.`);
  });

  it("säger att jämförelseperioden saknade order när det fanns data före den", () => {
    const h = orderHeadline({ ...base, compareTotals: { count: 0, amountOre: 0 } });
    expect(plain(h.aside)).toBe(`79 987 kr betalt, inga order 23 sep. –\u2060 12 okt.`);
  });

  it("säger order per dag när det inte finns någon jämförelse och perioden är full av data", () => {
    const h = orderHeadline({
      ...base,
      compare: null,
      compareTotals: null,
      dataStart: "2026-10-13",
    });
    // "Allt": perioden börjar med första ordern, så den upprepas inte.
    expect(plain(h.aside)).toBe(`79 987 kr betalt, i snitt 23 order per dag.`);
    const few = orderHeadline({
      ...base,
      totals: { count: 46, amountOre: 799_870 },
      compare: null,
      compareTotals: null,
    });
    expect(plain(few.aside)).toBe(`7 999 kr betalt, i snitt 2,3 order per dag.`);
  });

  it("säger när urvalets första order kom, med filter", () => {
    const h = orderHeadline({
      ...base,
      compare: null,
      compareTotals: null,
      dataStart: "2026-10-20",
      filtered: true,
    });
    expect(plain(h.aside)).toBe(`79 987 kr betalt, första ordern i urvalet kom 20 okt.`);
  });

  it("skriver i dag i stället för antal dagar", () => {
    expect(plain(orderHeadline({ ...base, periodKey: "idag", days: 1 }).title)).toBe(
      `460 order i dag.`,
    );
  });

  it("har egna rubriker för inga order, inga träffar och ingen data alls", () => {
    expect(plainH(orderHeadline({ ...base, totals: { count: 0, amountOre: 0 } }))).toEqual({
      title: `Inga order 13 okt. –\u2060 1 nov.`,
      aside: "Senaste ordern kom 1 nov. 17:17.",
    });
    expect(
      plainH(orderHeadline({ ...base, totals: { count: 0, amountOre: 0 }, filtered: true })),
    ).toEqual({
      title: "Inga order matchar filtret.",
      aside: "Senaste ordern som matchar kom 1 nov. 17:17.",
    });
    expect(
      orderHeadline({
        ...base,
        totals: { count: 0, amountOre: 0 },
        filtered: true,
        latestOrderAt: null,
      }).aside,
    ).toBe("Inte heller utanför perioden.");
    expect(orderHeadline({ ...base, hasOrders: false, latestOrderAt: null }).title).toBe(
      "Inga order ännu.",
    );
  });
});

describe("CSV", () => {
  const rows: OrderRow[] = [
    {
      id: "o1",
      externalId: "42780",
      orderedAt: "2026-11-01T16:17:00.000Z",
      businessDate: "2026-11-01",
      titleId: T1,
      rawTitle: "Pokemon 151",
      machineId: M1,
      storeId: S1,
      amountOre: 17_000,
      testPurchase: false,
    },
    {
      id: "o2",
      externalId: "42781",
      orderedAt: "2026-03-29T00:30:00.000Z",
      businessDate: "2026-03-29",
      titleId: null,
      rawTitle: '=HYPERLINK("x")',
      machineId: null,
      storeId: null,
      amountOre: 12_950,
      testPurchase: true,
    },
  ];

  it("skriver svensk tid, decimalkomma och skyddar mot formler", () => {
    const csv = orderCsv(rows, refs, "Europe/Stockholm");
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(
      "Ordernummer;Tid;Affärsdatum;Titel;Originaltitel;Automat;Automatnamn;Butik;Belopp (kr);Testköp",
    );
    expect(lines[1]).toBe(
      "42780;2026-11-01 17:17;2026-11-01;Pokémon 151;Pokemon 151;BL-002;Centrum;Åhléns City;170,00;",
    );
    expect(lines[2]).toBe(`42781;2026-03-29 01:30;2026-03-29;;"'=HYPERLINK(""x"")";;;;129,50;Ja`);
    expect(csv.startsWith("﻿")).toBe(true);
  });

  it("räknar tid över sommartidsskiftet i organisationens tidszon", () => {
    expect(csvTime("2026-03-29T01:30:00.000Z", "Europe/Stockholm")).toBe("2026-03-29 03:30");
    expect(csvTime("inte en tid", "Europe/Stockholm")).toBe("");
  });

  it("ger samma tid som Intl minut för minut runt båda sommartidsskiftena", () => {
    const fast = csvTimeFormatter("Europe/Stockholm");
    const exact = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Stockholm",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    for (const startIso of ["2026-03-28T22:00:00Z", "2026-10-24T22:00:00Z"]) {
      const start = Date.parse(startIso);
      for (let m = 0; m < 6 * 60; m += 7) {
        const iso = new Date(start + m * 60_000).toISOString();
        expect(fast(iso)).toBe(exact.format(new Date(iso)).replace(",", ""));
      }
    }
    // En tidszon med halvtimmesförskjutning.
    expect(csvTime("2026-01-01T00:10:00Z", "Asia/Kolkata")).toBe("2026-01-01 05:40");
  });

  it("skriver öre som kronor exakt som formatCsvNumber", () => {
    for (const ore of [0, 5, 100, 12_950, 7_998_700, -350]) {
      expect(csvKronor(ore)).toBe(formatCsvNumber(ore / 100, 2));
    }
  });

  it("ger samma fil i strömmade delar som i ett stycke", () => {
    const columns = orderCsvColumns(refs, "Europe/Stockholm");
    const parts =
      orderCsvPart(rows.slice(0, 1), columns, true) + orderCsvPart(rows.slice(1), columns, false);
    expect(parts).toBe(orderCsv(rows, refs, "Europe/Stockholm"));
    expect(orderCsvPart([], columns, false)).toBe("");
    expect(orderCsvPart([], columns, true)).toBe(orderCsv([], refs, "Europe/Stockholm"));
  });

  it("namnger filen efter perioden", () => {
    expect(orderCsvFileName({ start: "2026-10-13", end: "2026-11-01" })).toBe(
      "order-2026-10-13--2026-11-01.csv",
    );
  });
});

describe("testköp", () => {
  it("en markering i detaljvyn gäller före radens värde från servern", () => {
    const row = { id: "o1", testPurchase: false };
    expect(isTestPurchase(row, new Map())).toBe(false);
    expect(isTestPurchase(row, new Map([["o1", true]]))).toBe(true);
    expect(isTestPurchase({ id: "o1", testPurchase: true }, new Map([["o1", false]]))).toBe(false);
    expect(isTestPurchase({ id: "o2", testPurchase: true }, new Map([["o1", false]]))).toBe(true);
  });

  it("säger när och av vem, och inget för en vanlig order", () => {
    const at = (iso: string) => iso.slice(0, 10);
    expect(testPurchaseNote(null, at)).toBeNull();
    expect(testPurchaseNote({ at: "2026-11-03T09:00:00.000Z", by: "Kim" }, at)).toBe(
      "Markerat 2026-11-03 av Kim.",
    );
    expect(testPurchaseNote({ at: "2026-11-03T09:00:00.000Z", by: "  " }, at)).toBe(
      "Markerat 2026-11-03.",
    );
    expect(testPurchaseNote({ at: "2026-11-03T09:00:00.000Z", by: null }, at)).toBe(
      "Markerat 2026-11-03.",
    );
  });
});
