import { describe, expect, it } from "vitest";

import {
  APP_ICON,
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
const BASE = "https://app.example.se";

const opts = (over: Partial<SalePushOptions> = {}): SalePushOptions => ({
  kronor: true,
  timeZone: TZ,
  baseUrl: BASE,
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
    expect(p.icon).toBe(`${BASE}/packs/surging-sparks.webp`);
    expect(p.image).toBe(`${BASE}/packs/surging-sparks.webp`);
    expect(p.severity).toBe("info");
    expect(p.tag).toMatch(/^salj-/);
  });

  it("öre visas bara när beloppet inte är jämnt", () => {
    expect(salePushPayload([sale({ amountOre: 14950 })], opts()).body).toContain(`149,50${NBSP}kr`);
  });

  it("utan packbild: appens ikon, ingen bild; utan butik och automat: bara belopp och tid", () => {
    const p = salePushPayload(
      [sale({ title: "Okänd vara", machineName: null, storeName: null })],
      opts(),
    );
    expect(p.icon).toBe(`${BASE}${APP_ICON}`);
    expect(p.image).toBeUndefined();
    expect(p.body).toBe(`149${NBSP}kr · 14:32`);
  });

  it("utan appens adress: relativa adresser (service workern tar dem från sin egen adress)", () => {
    expect(salePushPayload([sale()], opts({ baseUrl: null })).icon).toBe(
      "/packs/surging-sparks.webp",
    );
  });

  it("utan kronor (påfyllaren): inget belopp någonstans", () => {
    const p = salePushPayload([sale()], opts({ kronor: false }));
    expect(p.title).toBe("Sålt: Surging Sparks Booster");
    expect(p.body).toBe("Centrum · Butiken · 14:32");
    expect(JSON.stringify(p)).not.toMatch(/kr\b|149/);
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
    expect(p.icon).toBe(`${BASE}${APP_ICON}`);
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

  it("en ny grupp får en egen tagg (staplas), samma grupp samma tagg", () => {
    const a = five();
    expect(salePushPayload(a, opts()).tag).toBe(salePushPayload(a, opts()).tag);
    expect(salePushPayload(a, opts()).tag).not.toBe(salePushPayload(five(), opts()).tag);
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

  it("tyst 22–07 i organisationens tidszon", () => {
    expect(inQuietHours(new Date("2026-11-23T21:00:00Z"), TZ)).toBe(true); // 22:00
    expect(inQuietHours(new Date("2026-11-23T05:59:00Z"), TZ)).toBe(true); // 06:59
    expect(inQuietHours(new Date("2026-11-23T06:00:00Z"), TZ)).toBe(false); // 07:00
    expect(inQuietHours(new Date("2026-11-23T20:59:00Z"), TZ)).toBe(false); // 21:59
  });
});
