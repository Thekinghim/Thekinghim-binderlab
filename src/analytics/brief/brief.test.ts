import { describe, expect, it } from "vitest";

import { buildBriefCards, limitLinks, MAX_BRIEF_CARDS, shortDate, type BriefInput } from "./index";

const base: BriefInput = {
  role: "owner",
  today: "2026-11-26",
  machines: [],
  route: null,
};

const full: BriefInput = {
  ...base,
  machines: [
    { id: "m1", name: "Automat Norr", kind: "fyll-pa", packs: 24, lossOre: 24_000 },
    { id: "m2", name: "Automat Syd", kind: "tom", packs: 30, lossOre: 12_000 },
    { id: "m3", name: "Automat Väst", kind: "offline", packs: null },
  ],
  route: { stops: 3, done: 0, cities: ["Stad A", "Stad B"], totalPacks: 54, km: 42 },
  alerts: [{ title: "Kortläsaren svarar inte", href: "/drift#larm" }],
  settlements: [{ count: 2, totalOre: 1_240_000, due: "2026-12-15", href: "/butiker?vy=x" }],
  lossPrices: [{ name: "Titel A", lossOre: 3_000, suggestedPriceOre: 19_900 }],
  missingPrices: [{ name: "Titel B", href: "/inkopspriser?titel=b" }],
  yesterday: { units: 18, revenueOre: 234_000, normalRevenueOre: 180_000 },
};

const KR = /\bkr\b|kronor/i;

describe("buildBriefCards", () => {
  it("viktigast först: larm, påfyllning, rutt, betala, pris, i går", () => {
    const cards = buildBriefCards(full);
    expect(cards.map((c) => c.key)).toEqual([
      "alert",
      "refill",
      "route",
      "settlement",
      "loss-price",
      "missing-price",
    ]);
    expect(cards).toHaveLength(MAX_BRIEF_CARDS);
  });

  it("högst sex kort (i går faller bort först)", () => {
    expect(buildBriefCards(full).some((c) => c.key === "yesterday")).toBe(false);
    const fewer = buildBriefCards({ ...full, missingPrices: [] });
    expect(fewer.at(-1)?.key).toBe("yesterday");
  });

  it("påfyllningskortet: antal i rubriken, första automaten och pack på raden", () => {
    const card = buildBriefCards(full).find((c) => c.key === "refill");
    expect(card?.title).toBe("2 automater behöver fyllas på");
    expect(card?.line).toBe("Automat Norr är nästan tom · ta med 24 pack");
    expect(card?.action).toEqual({ label: "Fyll på", href: "/fyll-pa/m1?fran=hem" });
  });

  it("betalning som förfaller i dag går före påfyllningen", () => {
    const cards = buildBriefCards({
      ...full,
      settlements: [{ count: 1, totalOre: 50_000, due: "2026-11-26", href: "/butiker?vy=x" }],
    });
    expect(cards.map((c) => c.key).slice(0, 3)).toEqual(["alert", "settlement", "refill"]);
    expect(cards[1]?.line).toBe("1 butik · senast i dag");
  });

  it("påfyllaren: bara påfyllning och rutt, aldrig kronor", () => {
    const cards = buildBriefCards({ ...full, role: "refiller" });
    expect(cards.map((c) => c.key)).toEqual(["refill", "route"]);
    for (const c of cards) {
      expect(c.title).not.toMatch(KR);
      expect(c.line).not.toMatch(KR);
    }
  });

  it("påfyllaren utan pack: förlusten i kronor visas inte", () => {
    const cards = buildBriefCards({
      ...base,
      role: "refiller",
      machines: [{ id: "m1", name: "Automat Norr", kind: "tom", packs: null, lossOre: 90_000 }],
    });
    expect(cards[0]?.line).toBe("Automat Norr är tom");
  });

  it("ägaren utan pack ser förlusten per dag", () => {
    const cards = buildBriefCards({
      ...base,
      machines: [{ id: "m1", name: "Automat Norr", kind: "tom", packs: null, lossOre: 90_000 }],
    });
    expect(cards[0]?.line).toMatch(/tappar 900 kr\/dag/);
  });

  it("läsaren ser ekonomin men knapparna bara visar", () => {
    const cards = buildBriefCards({ ...full, role: "viewer" });
    expect(cards.map((c) => c.key)).toContain("settlement");
    for (const c of cards) {
      if (c.key === "route") continue;
      expect(c.action?.label).toBe("Visa");
      expect(c.action?.href).not.toMatch(/^\/fyll-pa/);
    }
  });

  it("inget att göra: ett kort Allt är klart", () => {
    const cards = buildBriefCards(base);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: "done", title: "Allt är klart i dag", action: null });
  });

  it("inget att göra men i går finns: Allt är klart först, sedan i går", () => {
    const cards = buildBriefCards({ ...base, yesterday: full.yesterday });
    expect(cards.map((c) => c.key)).toEqual(["done", "yesterday"]);
    expect(cards[1]?.title).toBe("I går: 2 340 kr");
    expect(cards[1]?.line).toBe("18 pack sålda · bättre än vanligt");
  });

  it("påfyllaren får inget i går-kort och inga larm", () => {
    const cards = buildBriefCards({
      ...base,
      role: "refiller",
      alerts: full.alerts,
      yesterday: full.yesterday,
    });
    expect(cards.map((c) => c.key)).toEqual(["done"]);
  });

  it("rutten som är klar ger inget kort", () => {
    const cards = buildBriefCards({
      ...base,
      route: { stops: 2, done: 2, cities: ["Stad A"], totalPacks: 10, km: 5 },
    });
    expect(cards.map((c) => c.key)).toEqual(["done"]);
  });

  it("larm utan automat offline", () => {
    const cards = buildBriefCards({ ...base, alerts: full.alerts });
    expect(cards[0]).toMatchObject({
      key: "alert",
      title: "1 larm att titta på",
      line: "Kortläsaren svarar inte",
      action: { label: "Se larm", href: "/drift#larm" },
    });
  });
});

describe("shortDate", () => {
  it("dag och kort månad", () => {
    expect(shortDate("2026-12-15")).toBe("15 dec");
  });
});

describe("limitLinks", () => {
  const cards = buildBriefCards({
    ...full,
    role: "viewer",
    machines: [],
    alerts: [{ title: "Kontrollen gick inte igenom", href: "/installningar/kontroll" }],
  });

  it("larm till en sida rollen inte får öppna går till larmlistan", () => {
    const out = limitLinks(cards, (href) => !href.startsWith("/installningar"));
    const alert = out.find((c) => c.key === "alert");
    expect(alert?.action?.href).toBe("/drift#larm");
    expect(alert?.action?.label).toBe("Visa");
  });

  it("andra kort utan tillåten sida får ingen länk (knappen stänger)", () => {
    const out = limitLinks(cards, (href) => !href.startsWith("/lonsamhet"));
    expect(out.find((c) => c.key === "loss-price")?.action).toBeNull();
    expect(out.find((c) => c.key === "route")?.action?.href).toBe("/rutt");
  });
});

describe("betala butikerna över flera månader", () => {
  it("räknar avräkningar, inte butiker två gånger", () => {
    const cards = buildBriefCards({
      ...base,
      settlements: [
        { count: 2, totalOre: 100_000, due: "2026-11-15", href: "/a" },
        { count: 2, totalOre: 50_000, due: "2026-12-15", href: "/b" },
      ],
    });
    const s = cards.find((c) => c.key === "settlement");
    expect(s?.line).toMatch(/^4 avräkningar/);
    expect(s?.action?.href).toBe("/butiker?vy=utbetalning");
  });
});
