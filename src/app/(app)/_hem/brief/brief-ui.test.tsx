import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { buildBriefCards } from "@/analytics/brief";

import { BriefDeck } from "./dialog";
import { markSeen, resetVisitForTests, seenToday, todayIn, type KeyValueStore } from "./once";

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

const broken: KeyValueStore = {
  getItem: () => {
    throw new Error("spärrad");
  },
  setItem: () => {
    throw new Error("spärrad");
  },
};

describe("en gång per dag", () => {
  beforeEach(() => resetVisitForTests());

  it("visas inte igen samma dag, men nästa dag", () => {
    const s = memory();
    expect(seenToday("u1", "2026-11-26", s)).toBe(false);
    markSeen("u1", "2026-11-26", s);
    expect(seenToday("u1", "2026-11-26", s)).toBe(true);
    expect(seenToday("u1", "2026-11-27", s)).toBe(false);
  });

  it("per användare", () => {
    const s = memory();
    markSeen("u1", "2026-11-26", s);
    expect(seenToday("u2", "2026-11-26", s)).toBe(false);
  });

  it("utan fungerande lagring: högst en gång per besök", () => {
    expect(seenToday("u1", "2026-11-26", broken)).toBe(false);
    markSeen("u1", "2026-11-26", broken);
    expect(seenToday("u1", "2026-11-26", broken)).toBe(true);
    expect(seenToday("u1", "2026-11-26", null)).toBe(true);
  });

  it("dagen räknas i svensk tid", () => {
    // 23:30 UTC den 26:e är redan den 27:e i Stockholm.
    expect(todayIn("Europe/Stockholm", new Date("2026-11-26T23:30:00Z"))).toBe("2026-11-27");
    expect(todayIn("Europe/Stockholm", new Date("2026-11-26T10:00:00Z"))).toBe("2026-11-26");
  });
});

describe("BriefDeck", () => {
  const cards = buildBriefCards({
    role: "owner",
    today: "2026-11-26",
    machines: [{ id: "m1", name: "Automat Norr", kind: "fyll-pa", packs: 24 }],
    route: { stops: 2, done: 0, cities: ["Stad A"], totalPacks: 30, km: 12 },
  });

  it("ett kort per sak, prickar och rubrik för skärmläsare", () => {
    const html = renderToStaticMarkup(<BriefDeck cards={cards} index={0} />);
    expect(html).toContain('id="dagens-brief-rubrik"');
    expect(html.match(/class="bf-slide"/g)).toHaveLength(2);
    expect(html.match(/class="bf-dot"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Kort 1 av 2"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("1 automat behöver fyllas på");
    expect(html).toContain("<svg");
  });

  it("korten som inte syns är dolda för skärmläsare", () => {
    const html = renderToStaticMarkup(<BriefDeck cards={cards} index={1} />);
    expect(html).toMatch(/aria-label="1 av 2" aria-hidden="true"/);
  });

  it("ett enda kort: inga prickar", () => {
    const done = buildBriefCards({ role: "owner", today: "2026-11-26", machines: [], route: null });
    const html = renderToStaticMarkup(<BriefDeck cards={done} index={0} />);
    expect(html).not.toContain("bf-dot");
    expect(html).toContain("Allt är klart i dag");
  });
});
