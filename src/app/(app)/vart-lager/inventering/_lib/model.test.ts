import { describe, expect, it } from "vitest";

import {
  countedCount,
  newDraft,
  parseCount,
  parseDrafts,
  summarize,
  withCount,
  type CountRow,
} from "./model";

const HEMMA = "11111111-1111-4111-8111-111111111111";
const KONTORET = "22222222-2222-4222-8222-222222222222";
const PALDEA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SURGING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRISMATIC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-11-10T09:00:00Z");

const rows: CountRow[] = [
  { titleId: PALDEA, name: "Paldea", byPlace: { [HEMMA]: 162, [KONTORET]: 3 } },
  { titleId: SURGING, name: "Surging Sparks", byPlace: { [HEMMA]: 40 } },
  { titleId: PRISMATIC, name: "Prismatic", byPlace: { [HEMMA]: -2 } },
];

describe("parseCount", () => {
  it("heltal 0–10 000", () => {
    expect(parseCount("0")).toEqual({ ok: true, n: 0 });
    expect(parseCount(" 162 ")).toEqual({ ok: true, n: 162 });
    expect(parseCount("10000")).toEqual({ ok: true, n: 10000 });
  });
  it("tomt, text, decimaler och minus är inte ett antal; över 10 000 är för mycket", () => {
    for (const bad of ["", " ", "12,5", "1.5", "-3", "tolv"]) {
      expect(parseCount(bad)).toEqual({ ok: false, error: "min" });
    }
    expect(parseCount("10001")).toEqual({ ok: false, error: "max" });
  });
});

describe("utkastet", () => {
  it("ett värde sparas som siffror, tomt tar bort titeln (hoppas över)", () => {
    let d = newDraft(CLIENT, NOW);
    d = withCount(d, PALDEA, "0", NOW);
    d = withCount(d, SURGING, " 4 1x", NOW);
    expect(d.counts).toEqual({ [PALDEA]: "0", [SURGING]: "41" });
    d = withCount(d, SURGING, "", NOW);
    expect(d.counts).toEqual({ [PALDEA]: "0" });
    expect(d.clientId).toBe(CLIENT);
  });

  it("går runt genom lagringen (JSON) utan att tappa något", () => {
    const d = { ...withCount(newDraft(CLIENT, NOW, "list"), PALDEA, "12", NOW), index: 2 };
    const back = parseDrafts(JSON.stringify({ [HEMMA]: d }));
    expect(back).toEqual({ [HEMMA]: d });
    expect(countedCount(rows, back[HEMMA])).toBe(1);
  });

  it("trasig eller okänd lagring ger inga utkast, aldrig ett fel", () => {
    expect(parseDrafts(null)).toEqual({});
    expect(parseDrafts("")).toEqual({});
    expect(parseDrafts("{inte json")).toEqual({});
    expect(parseDrafts("[]")).toEqual({});
    expect(parseDrafts(JSON.stringify({ [HEMMA]: { clientId: "x", counts: {} } }))).toEqual({});
    expect(parseDrafts(JSON.stringify({ hemma: newDraft(CLIENT, NOW) }))).toEqual({});
    // Ett trasigt utkast tar inte med sig de andra.
    const ok = newDraft(CLIENT, NOW);
    expect(parseDrafts(JSON.stringify({ [HEMMA]: ok, [KONTORET]: { counts: 1 } }))).toEqual({
      [HEMMA]: ok,
    });
  });

  it("ett ändrat antal får ett nytt inskicks-id: ett nytt försök efter en ändring sparas", () => {
    const NEXT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let d = withCount(newDraft(CLIENT, NOW), PALDEA, "5", NOW);
    // Samma värde igen (eller bara skräptecken): samma id, så ett dubbeltryck sparas en gång.
    d = withCount(d, PALDEA, "5x", NOW, { clientId: NEXT });
    expect(d.clientId).toBe(CLIENT);
    // Ett annat värde: nytt id, så att servern inte svarar "redan sparad" med det gamla.
    d = withCount(d, PALDEA, "6", NOW, { clientId: NEXT });
    expect(d.clientId).toBe(NEXT);
    expect(d.counts).toEqual({ [PALDEA]: "6" });
  });

  it("minns vad appen trodde när antalet skrevs, och glömmer det när fältet töms", () => {
    let d = withCount(newDraft(CLIENT, NOW), PALDEA, "162", NOW, { expected: 162 });
    d = withCount(d, SURGING, "39", NOW, { expected: 40 });
    expect(d.seen).toEqual({ [PALDEA]: 162, [SURGING]: 40 });
    d = withCount(d, SURGING, "", NOW, { expected: 40 });
    expect(d.seen).toEqual({ [PALDEA]: 162 });
    expect(parseDrafts(JSON.stringify({ [HEMMA]: d }))).toEqual({ [HEMMA]: d });
    // Trasigt "seen" ger inget utkast.
    expect(parseDrafts(JSON.stringify({ [HEMMA]: { ...d, seen: { [PALDEA]: "x" } } }))).toEqual({});
  });

  it("räknar bara produkter som finns kvar i listan", () => {
    const d = withCount(withCount(newDraft(CLIENT, NOW), PALDEA, "1", NOW), CLIENT, "5", NOW);
    expect(countedCount(rows, d)).toBe(1);
    expect(countedCount(rows, undefined)).toBe(0);
  });
});

describe("summarize", () => {
  it("skillnader, det som stämde och det som hoppades över", () => {
    const s = summarize(rows, HEMMA, { [PALDEA]: "0", [SURGING]: "40" });
    expect(s.changed).toEqual([{ titleId: PALDEA, name: "Paldea", previous: 162, counted: 0 }]);
    expect(s.lines.map((l) => l.titleId)).toEqual([PALDEA, SURGING]);
    expect(s.same).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.invalid).toEqual([]);
  });

  it("räknar mot det valda lagret (saknas titeln där tror appen 0)", () => {
    const s = summarize(rows, KONTORET, { [PALDEA]: "3", [SURGING]: "0", [PRISMATIC]: "7" });
    expect(s.changed).toEqual([{ titleId: PRISMATIC, name: "Prismatic", previous: 0, counted: 7 }]);
    expect(s.same).toBe(2);
  });

  it("ett saldo under noll rättas av en räkning", () => {
    const s = summarize(rows, HEMMA, { [PRISMATIC]: "0" });
    expect(s.changed).toEqual([
      { titleId: PRISMATIC, name: "Prismatic", previous: -2, counted: 0 },
    ]);
  });

  it("för stort antal är ogiltigt och skickas inte", () => {
    const s = summarize(rows, HEMMA, { [PALDEA]: "10001", [SURGING]: "1" });
    expect(s.invalid).toEqual([PALDEA]);
    expect(s.lines.map((l) => l.titleId)).toEqual([SURGING]);
  });

  it("lagret ändrades medan man räknade: raden pekas ut", () => {
    // Paldea räknades till 162 när appen trodde 162. Sedan fylldes en automat på (−20).
    const moved: CountRow[] = [
      { titleId: PALDEA, name: "Paldea", byPlace: { [HEMMA]: 142 } },
      { titleId: SURGING, name: "Surging Sparks", byPlace: { [HEMMA]: 40 } },
    ];
    const s = summarize(
      moved,
      HEMMA,
      { [PALDEA]: "162", [SURGING]: "38" },
      { [PALDEA]: 162, [SURGING]: 40 },
    );
    expect(s.changed.map((l) => l.titleId)).toEqual([PALDEA, SURGING]);
    expect(s.stale).toEqual([
      { titleId: PALDEA, name: "Paldea", seen: 162, previous: 142, counted: 162 },
    ]);
    // Stämmer det räknade med appen nu finns inget att varna för.
    expect(summarize(moved, HEMMA, { [PALDEA]: "142" }, { [PALDEA]: 162 }).stale).toEqual([]);
    // Utan "seen" (äldre utkast): ingen varning.
    expect(summarize(moved, HEMMA, { [PALDEA]: "162" }).stale).toEqual([]);
  });

  it("titlar i utkastet som inte finns kvar räknas inte", () => {
    const s = summarize(rows, HEMMA, { [CLIENT]: "9" });
    expect(s.lines).toEqual([]);
    expect(s.skipped).toBe(3);
  });
});
