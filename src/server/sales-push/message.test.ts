import { describe, expect, it } from "vitest";

import {
  SALE_PUSH_CAP,
  inQuietHours,
  saleHref,
  salePushPayload,
  saleTime,
  type SaleItem,
  type SalePushOptions,
} from "./message";

const NBSP = "\u00a0";
const TZ = "Europe/Stockholm";
/** Måndag 23 november 2026 15:00 svensk tid. */
const NOW = new Date("2026-11-23T14:00:00Z");
const ORG = "0a1b2c3d-0000-4000-8000-000000000000";

const opts = (over: Partial<SalePushOptions> = {}): SalePushOptions => ({
  kronor: true,
  timeZone: TZ,
  orgId: ORG,
  now: NOW,
  ...over,
});

let n = 0;
function sale(over: Partial<SaleItem> = {}): SaleItem {
  n += 1;
  return {
    orderId: `0000000${n}`.slice(-8) + "-0000-4000-8000-000000000000",
    title: "Surging Sparks Booster",
    machineName: "Centrum",
    storeName: "Butiken",
    amountOre: 14900,
    orderedAt: "2026-11-23T13:32:00Z",
    ...over,
  };
}

describe("salePushPayload: ett köp", () => {
  it("titel, automat, butik, belopp och tid, packbilden som ikon och Hem med I dag", () => {
    const p = salePushPayload([sale()], opts());
    expect(p.title).toBe("Sålt: Surging Sparks Booster");
    expect(p.body).toBe(`Centrum · Butiken · 149${NBSP}kr · 14:32`);
    expect(p.url).toBe("/?period=idag");
    // Relativ: service workern gör den absolut mot den adress som personen har installerat.
    expect(p.icon).toBe("/packs/surging-sparks.webp");
    // Ingen stor bild (Android skulle beskära packen till en banderoll).
    expect(p).not.toHaveProperty("image");
    expect(p.severity).toBe("info");
    expect(p.tag).toBe("salj-0a1b2c3d-20261123");
  });

  it("öre visas bara när beloppet inte är jämnt", () => {
    expect(salePushPayload([sale({ amountOre: 14950 })], opts()).body).toContain(`149,50${NBSP}kr`);
  });

  it("utan packbild: ingen ikon (service workerns appikon); utan butik och automat: bara belopp och tid", () => {
    const p = salePushPayload(
      [sale({ title: "Okänd vara", machineName: null, storeName: null })],
      opts(),
    );
    expect(p).not.toHaveProperty("icon");
    expect(p.body).toBe(`149${NBSP}kr · 14:32`);
  });

  it("utan kronor: titel och automat, ingen butik, ingen tid, inget belopp", () => {
    const p = salePushPayload([sale()], opts({ kronor: false }));
    expect(p.title).toBe("Sålt: Surging Sparks Booster");
    expect(p.body).toBe("Centrum");
    expect(JSON.stringify(p)).not.toMatch(/kr\b|149|14:32|Butiken/);
  });

  it("flera organisationer: organisationens namn sist", () => {
    const p = salePushPayload([sale()], opts({ orgName: "Andra AB" }));
    expect(p.body).toBe(`Centrum · Butiken · 149${NBSP}kr · 14:32 · Andra AB`);
  });

  it("strax efter midnatt: köpet från i går öppnar I går", () => {
    const p = salePushPayload([sale({ orderedAt: "2026-11-22T22:58:00Z" })], {
      ...opts(),
      now: new Date("2026-11-22T23:05:00Z"), // 00:05 den 23:e
    });
    expect(p.url).toBe("/?period=igar");
    expect(p.body).toContain("i går 23:58");
  });

  it("Enkel vy: notisen öppnar startsidan", () => {
    expect(salePushPayload([sale()], opts({ simple: true })).url).toBe(saleHref(true));
    expect(saleHref(true)).toBe("/");
  });

  it("en lång titel kortas", () => {
    const p = salePushPayload([sale({ title: "x".repeat(300) })], opts());
    expect(p.title.length).toBeLessThanOrEqual(120);
    expect(p.title.endsWith("…")).toBe(true);
  });
});

describe("salePushPayload: flera köp i samma synk", () => {
  const five = () => [
    sale({ title: "A", amountOre: 10000, orderedAt: "2026-11-23T13:01:00Z" }),
    sale({ title: "B", amountOre: 9900, orderedAt: "2026-11-23T13:02:00Z" }),
    sale({ title: "C", amountOre: 8800, orderedAt: "2026-11-23T13:03:00Z" }),
    sale({ title: "D", amountOre: 8000, orderedAt: "2026-11-23T13:04:00Z" }),
    sale({ title: "E", amountOre: 8000, orderedAt: "2026-11-23T13:05:00Z" }),
  ];

  it("antal och summa, tre titlar (nyast först) och 'och 2 till'", () => {
    const p = salePushPayload(five(), opts());
    expect(p.title).toBe(`5 sålda · 447${NBSP}kr`);
    expect(p.body).toBe("E, D, C och 2 till");
    expect(p).not.toHaveProperty("icon");
    expect(p.url).toBe("/?period=idag");
  });

  it("samma titel flera gånger räknas ihop", () => {
    const p = salePushPayload(
      [
        sale({ title: "A", orderedAt: "2026-11-23T13:01:00Z" }),
        sale({ title: "A", orderedAt: "2026-11-23T13:02:00Z" }),
        sale({ title: "B", orderedAt: "2026-11-23T13:03:00Z" }),
      ],
      opts(),
    );
    expect(p.title).toBe(`3 sålda · 447${NBSP}kr`);
    expect(p.body).toBe("B, 2 × A");
  });

  it("utan kronor: bara antal och titlar", () => {
    const p = salePushPayload(five(), opts({ kronor: false }));
    expect(p.title).toBe("5 sålda");
    expect(p.body).toBe("E, D, C och 2 till");
    expect(JSON.stringify(p)).not.toMatch(/kr\b/);
  });

  it("en tagg per organisation och dag: en ny notis ersätter den förra", () => {
    const tag = salePushPayload(five(), opts()).tag;
    expect(salePushPayload([sale()], opts()).tag).toBe(tag);
    expect(
      salePushPayload(five(), opts({ orgId: "ffffffff-0000-4000-8000-000000000000" })).tag,
    ).not.toBe(tag);
    expect(salePushPayload([sale({ orderedAt: "2026-11-22T12:00:00Z" })], opts()).tag).toBe(
      "salj-0a1b2c3d-20261122",
    );
  });

  it("långa titlar kortas, så att 'och 2 till' syns på en låst iPhone", () => {
    const long = (i: number) =>
      sale({
        title: `Pokémon TCG: Scarlet & Violet – Prismatic Evolutions Booster ${i}`,
        orderedAt: `2026-11-23T13:0${i}:00Z`,
      });
    const p = salePushPayload([1, 2, 3, 4, 5].map(long), opts());
    expect(p.body.length).toBeLessThanOrEqual(100);
    expect(p.body).toMatch(/och 2 till$/);
    expect(p.body).toContain("…");
  });

  it(`fler än ${SALE_PUSH_CAP}: en sammanfattning, ingen lista`, () => {
    const many = Array.from({ length: SALE_PUSH_CAP + 4 }, (_v, i) =>
      sale({
        title: `T${i}`,
        amountOre: 14900,
        orderedAt: new Date(Date.parse("2026-11-23T12:10:00Z") + i * 60_000).toISOString(),
      }),
    );
    const p = salePushPayload(many, opts());
    expect(p.title).toBe(`24 sålda · 3${NBSP}576${NBSP}kr`);
    expect(p.body).toBe("Sedan 13:10. Öppna Hem för listan.");
    expect(p.body).not.toContain("T0");
    const free = salePushPayload(many, opts({ kronor: false }));
    expect(free.title).toBe("24 sålda");
  });

  it("precis på gränsen blir det fortfarande en lista", () => {
    const list = Array.from({ length: SALE_PUSH_CAP }, (_v, i) => sale({ title: `T${i}` }));
    expect(salePushPayload(list, opts()).body).toMatch(/och 17 till$/);
  });

  it("en tom lista är ett programfel", () => {
    expect(() => salePushPayload([], opts())).toThrow(RangeError);
  });
});

describe("tider", () => {
  it("klockslag i organisationens tidszon, 'i går' för gårdagen", () => {
    expect(saleTime("2026-11-23T13:32:00Z", TZ, NOW)).toBe("14:32");
    expect(saleTime("2026-11-22T22:58:00Z", TZ, NOW)).toBe("i går 23:58");
  });

  it("'i går' stämmer natten efter sommartidsskiftet (dygnet var 23 timmar)", () => {
    // 00:30 den 29 mars 2027 i Stockholm; köpet 23:00 den 28 mars (sommartid sedan 02:00).
    const now = new Date("2027-03-28T22:30:00Z");
    expect(saleTime("2027-03-28T21:00:00Z", TZ, now)).toBe("i går 23:00");
    expect(saleTime("2027-03-27T21:00:00Z", TZ, now)).toBe("22:00");
  });

  it("tyst 22–07 i organisationens tidszon", () => {
    expect(inQuietHours(new Date("2026-11-23T21:00:00Z"), TZ)).toBe(true); // 22:00
    expect(inQuietHours(new Date("2026-11-23T05:59:00Z"), TZ)).toBe(true); // 06:59
    expect(inQuietHours(new Date("2026-11-23T06:00:00Z"), TZ)).toBe(false); // 07:00
    expect(inQuietHours(new Date("2026-11-23T20:59:00Z"), TZ)).toBe(false); // 21:59
  });
});
