import { describe, expect, it } from "vitest";

import { portalScreenOf, screensForPortal } from "./screens";

const names: Record<string, string> = {
  a: "Prismatic Evolutions",
  b: "Surging Sparks",
  c: "Black Bolt",
};
const base = { machineId: "m1", readAt: null, titleName: (id: string) => names[id] };
const row = (title_id: string, units: number, capacity: number, channels = 1, empty = 0) => ({
  title_id,
  units,
  capacity,
  channels,
  empty,
});

describe("portalScreenOf", () => {
  it("utan läsning: inga pack, okänt antal fack, läget ok", () => {
    const s = portalScreenOf({ ...base, appearance: null, fill: null });
    expect(s).toMatchObject({ look: "stjarnor", slots: [], channels: null, status: "ok" });
  });

  it("utseendet ur databasen, okänt blir stjärnor", () => {
    expect(portalScreenOf({ ...base, appearance: "gul", fill: [] }).look).toBe("gul");
    expect(portalScreenOf({ ...base, appearance: "rosa", fill: [] }).look).toBe("stjarnor");
  });

  it("fyllnad per titel, tomma fack och fack med pack", () => {
    const s = portalScreenOf({
      ...base,
      appearance: "stjarnor",
      fill: [row("a", 8, 10), row("b", 0, 10, 1, 1), row("c", 9, 10, 2, 0)],
    });
    expect(s.slots).toEqual([
      { title: "Prismatic Evolutions", fill: 0.8, empty: false },
      { title: "Surging Sparks", fill: 0, empty: true },
      { title: "Black Bolt", fill: 0.9, empty: false },
    ]);
    expect(s.channels).toBe(4);
    expect(s.channelsWithPacks).toBe(3);
    expect(s.status).toBe("refill");
  });

  it("allt fullt = ok, nästan tomt = fyll på, inga pack = tom", () => {
    expect(portalScreenOf({ ...base, appearance: null, fill: [row("a", 9, 10)] }).status).toBe(
      "ok",
    );
    expect(portalScreenOf({ ...base, appearance: null, fill: [row("a", 2, 10)] }).status).toBe(
      "refill",
    );
    expect(portalScreenOf({ ...base, appearance: null, fill: [row("a", 0, 10)] }).status).toBe(
      "empty",
    );
  });

  it("titlar utan namn hoppas över men räknas i facken", () => {
    const s = portalScreenOf({
      ...base,
      appearance: null,
      fill: [row("a", 5, 10), row("okand", 5, 10)],
    });
    expect(s.slots.map((x) => x.title)).toEqual(["Prismatic Evolutions"]);
    expect(s.channels).toBe(2);
  });

  it("lämnar inga belopp ut", () => {
    const s = portalScreenOf({ ...base, appearance: null, fill: [row("a", 5, 10)] });
    expect(JSON.stringify(s)).not.toMatch(/ore|price|cost|kr/i);
  });
});

describe("screensForPortal", () => {
  const screen = portalScreenOf({
    ...base,
    appearance: "gul",
    fill: [row("a", 2, 10, 2, 1), row("b", 8, 10)],
  });

  it("med detaljer: titlarna står kvar", () => {
    expect(screensForPortal([screen], true)[0]!.slots.map((s) => s.title)).toEqual([
      "Prismatic Evolutions",
      "Surging Sparks",
    ]);
  });

  it("utan detaljer: inga titlar, men läget och facken står kvar", () => {
    const [s] = screensForPortal([screen], false);
    expect(s!.slots).toEqual([]);
    expect(s).toMatchObject({
      look: "gul",
      status: screen.status,
      channels: 3,
      channelsWithPacks: 2,
    });
    expect(JSON.stringify(s)).not.toContain("Prismatic");
  });
});
