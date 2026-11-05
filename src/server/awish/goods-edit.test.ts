/**
 * "Redigera vara": läsningen av en vara som panelen läser den, UpdateGood-indata exakt som
 * panelens redigering (hela varan tillbaka, bara namn/SEK-pris/bild ändrade), planen och
 * kontrollen efteråt.
 */

import { describe, expect, it } from "vitest";

import type { BinderlabTitleState } from "./goods";
import { planFingerprint } from "./goods";
import {
  checkEditedGood,
  editGoodInputSchema,
  encodeUpdateGoodInput,
  GOOD_PERMISSIONS,
  mediaAfter,
  notSavedText,
  parseAwishGood,
  planEditGood,
  summaryOf,
  type AwishGoodFull,
} from "./goods-edit";

/** En vara som Goods svarar med den (decimalsträngar, enhet, attribut, två valutor). */
const RAW = {
  id: 42,
  name: "Delta Reign",
  description: "Delta Reign",
  multi_currency_enabled: true,
  prices: [
    {
      id: 420,
      price: "150.00",
      original_price: "199.00",
      member_price: "140.00",
      cost_price: "80.00",
      currency: { id: 2, name: "Svensk krona", code: "SEK", symbol: "kr" },
    },
    {
      id: 421,
      price: "14.50",
      original_price: "0.00",
      member_price: "0.00",
      cost_price: "0.00",
      currency: { id: 1, name: "US Dollar", code: "USD", symbol: "$" },
    },
  ],
  thumb: "https://img.example/a.png",
  media: ["https://img.example/a.png", "https://img.example/b.png"],
  content: "<p>Delta Reign</p>",
  slug: "delta-reign",
  updated_at: "2026-11-01 10:00:00",
  age_verification_enabled: false,
  age_verification_min: 0,
  unit: {
    id: 3,
    name: "st",
    display_name: "Styck",
    multiplier: 1,
    base_unit: "st",
    description: "",
  },
  attributes: [{ id: 9, label_name: "weight", label_value: ["100g"], immutable: false }],
  is_tax_exempt: false,
  tax_rate: "12.00",
  is_returnable: true,
};

const ALL = Object.values(GOOD_PERMISSIONS);
const good = (): AwishGoodFull => parseAwishGood(RAW);

const title = (over: Partial<BinderlabTitleState> = {}): BinderlabTitleState => ({
  titleId: "t-1",
  titleName: "Delta Reign",
  hasAlias: true,
  archived: false,
  ownProduct: false,
  purchasePriceOre: 9_000,
  ...over,
});

const input = (over: Record<string, unknown> = {}) =>
  editGoodInputSchema.parse({ goodId: 42, name: "Delta Reign", salePrice: "150", ...over });

describe("parseAwishGood", () => {
  it("läser varan som panelens redigering: tal, currency_id, unit_id och tax_rate", () => {
    const g = good();
    expect(g.prices[0]).toEqual({
      id: 420,
      currencyId: 2,
      currencyCode: "SEK",
      price: 150,
      originalPrice: 199,
      memberPrice: 140,
      costPrice: 80,
    });
    expect(g.unitId).toBe(3);
    expect(g.taxRate).toBe(12);
    expect(summaryOf(g)).toEqual({
      id: 42,
      name: "Delta Reign",
      priceOre: 15_000,
      thumb: "https://img.example/a.png",
    });
  });

  it("saknad valuta blir 1 och saknad enhet null (som panelen)", () => {
    const g = parseAwishGood({ ...RAW, unit: null, prices: [{ id: 5, price: "9.5" }] });
    expect(g.prices[0]!.currencyId).toBe(1);
    expect(g.unitId).toBeNull();
  });
});

describe("encodeUpdateGoodInput", () => {
  it("skickar hela varan tillbaka och ändrar bara namn, SEK-pris (samma id) och bild", () => {
    const out = encodeUpdateGoodInput(
      good(),
      { name: "Delta Reign ETB", priceOre: 16_000, imageUrl: "https://img.example/ny.png" },
      ALL,
    );
    expect(out).toEqual({
      name: "Delta Reign ETB",
      // Beskrivning och innehåll var namnet: de följer med.
      description: "Delta Reign ETB",
      thumb: "https://img.example/ny.png",
      content: "<p>Delta Reign ETB</p>",
      media: ["https://img.example/ny.png", "https://img.example/b.png"],
      multi_currency_enabled: true,
      slug: "delta-reign",
      unit_id: 3,
      attributes: [{ id: 9, label_name: "weight", label_value: ["100g"], immutable: false }],
      is_tax_exempt: false,
      tax_rate: 12,
      is_returnable: true,
      prices: [
        {
          id: 420,
          currency_id: 2,
          price: 160,
          original_price: 199,
          member_price: 140,
          cost_price: 80,
        },
        {
          id: 421,
          currency_id: 1,
          price: 14.5,
          original_price: 0,
          member_price: 0,
          cost_price: 0,
        },
      ],
    });
    // Fältordningen som panelens GoodInput.
    expect(Object.keys(out)).toEqual([
      "name",
      "description",
      "thumb",
      "content",
      "media",
      "multi_currency_enabled",
      "slug",
      "unit_id",
      "attributes",
      "is_tax_exempt",
      "tax_rate",
      "is_returnable",
      "prices",
    ]);
    expect(out.prices.every((p) => !("good_id" in p))).toBe(true);
  });

  it("utan behörighet skickas 0 och [] som panelen gör", () => {
    const out = encodeUpdateGoodInput(
      good(),
      { name: "Delta Reign", priceOre: 15_000, imageUrl: null },
      [GOOD_PERMISSIONS.update],
    );
    expect(out.attributes).toEqual([]);
    expect(out.prices[0]).toEqual({
      id: 420,
      currency_id: 2,
      price: 150,
      original_price: 0,
      member_price: 0,
      cost_price: 0,
    });
  });

  it("egen beskrivning och eget innehåll behålls vid nytt namn", () => {
    const g = parseAwishGood({ ...RAW, description: "Elite Trainer Box", content: "<p>ETB</p>" });
    const out = encodeUpdateGoodInput(g, { name: "Ny", priceOre: 15_000, imageUrl: null }, ALL);
    expect(out.description).toBe("Elite Trainer Box");
    expect(out.content).toBe("<p>ETB</p>");
    expect(out.thumb).toBe("https://img.example/a.png");
    expect(out.media).toEqual(RAW.media);
  });

  it("varan utan SEK-pris och ogiltigt pris nekas", () => {
    const usd = parseAwishGood({ ...RAW, prices: [RAW.prices[1]] });
    expect(() =>
      encodeUpdateGoodInput(usd, { name: "X", priceOre: 100, imageUrl: null }, ALL),
    ).toThrow(/inget pris i SEK/);
    expect(() =>
      encodeUpdateGoodInput(good(), { name: "X", priceOre: 0, imageUrl: null }, ALL),
    ).toThrow(/0,01 kr/);
  });

  it("ny bild först, den gamla huvudbilden bort, högst fem", () => {
    const g = parseAwishGood({
      ...RAW,
      media: ["a", "b", "c", "d", "e"].map((x) => `https://img.example/${x}.png`),
    });
    expect(mediaAfter(g, "https://img.example/ny.png")).toEqual([
      "https://img.example/ny.png",
      "https://img.example/b.png",
      "https://img.example/c.png",
      "https://img.example/d.png",
      "https://img.example/e.png",
    ]);
  });
});

describe("editGoodInputSchema", () => {
  it("pris 0,01–10 000 kr och namn 1–100 tecken", () => {
    expect(input({ salePrice: "0,01" }).salePrice).toBe(1);
    expect(input({ salePrice: "10000" }).salePrice).toBe(1_000_000);
    expect(() => input({ salePrice: "0" })).toThrow(/minst 0,01/);
    expect(() => input({ salePrice: "10000,01" })).toThrow(/högst/);
    expect(() => input({ salePrice: "abc" })).toThrow(/kronor/);
    expect(() => input({ name: "  " })).toThrow(/Skriv ett namn/);
    expect(() => input({ name: "x".repeat(101) })).toThrow(/högst 100/);
    expect(input({ name: "  Delta   Reign  " }).name).toBe("Delta Reign");
  });
});

describe("planEditGood", () => {
  const base = {
    good: good(),
    otherSameName: [],
    title: title(),
    newNameTitle: null,
    titleNameTaken: false,
    image: null,
    permissions: ALL,
  };

  it("namn och pris: rader, alias för det nya namnet och titeln byter namn", () => {
    const plan = planEditGood({
      ...base,
      input: input({ name: "Delta Reign ETB", salePrice: "160" }),
    });
    expect(plan.blocking).toBeNull();
    expect(plan.lines).toEqual([
      "Namn: Delta Reign → Delta Reign ETB",
      "Pris: 150 kr → 160 kr",
      "Beskrivningen i Awish får också det nya namnet.",
      "Binderlab: lägger till namnet Delta Reign ETB på titeln Delta Reign så försäljningen kopplas rätt.",
      "Binderlab: Delta Reign finns kvar, så gamla order hamnar rätt.",
      "Binderlab: titeln byter namn: Delta Reign → Delta Reign ETB",
    ]);
    expect(plan.binderlab).toEqual({
      titleId: "t-1",
      titleName: "Delta Reign",
      aliases: ["Delta Reign ETB"],
      renameTitle: { from: "Delta Reign", to: "Delta Reign ETB" },
    });
  });

  it("titeln heter något annat: den byter inte namn", () => {
    const plan = planEditGood({
      ...base,
      title: title({ titleName: "Scarlet & Violet Delta" }),
      input: input({ name: "Delta Reign ETB" }),
    });
    expect(plan.binderlab.renameTitle).toBeNull();
    expect(plan.binderlab.aliases).toEqual(["Delta Reign ETB"]);
  });

  it("titeln kopplad via namn utan alias: det gamla namnet läggs också till", () => {
    const plan = planEditGood({
      ...base,
      title: title({ hasAlias: false }),
      input: input({ name: "Delta Reign ETB" }),
    });
    expect(plan.binderlab.aliases).toEqual(["Delta Reign", "Delta Reign ETB"]);
  });

  it("bara versaler ändras: inget nytt alias men titeln följer med", () => {
    const plan = planEditGood({ ...base, input: input({ name: "DELTA REIGN" }) });
    expect(plan.binderlab.aliases).toEqual([]);
    expect(plan.binderlab.renameTitle).toEqual({ from: "Delta Reign", to: "DELTA REIGN" });
  });

  it("inget ändrat: ingen skickaknapp", () => {
    const plan = planEditGood({ ...base, input: input() });
    expect(plan.nothingToDo).toBe(true);
    expect(plan.lines).toEqual(["Inget är ändrat."]);
  });

  it("bild: byts", () => {
    const plan = planEditGood({ ...base, input: input(), image: { fileName: "delta.png" } });
    expect(plan.nothingToDo).toBe(false);
    expect(plan.lines).toEqual(["Bild: byts"]);
  });

  it("två varor med samma namn efter bytet stoppas", () => {
    const plan = planEditGood({
      ...base,
      input: input({ name: "Mystery Pack" }),
      otherSameName: [{ id: 6, name: "Mystery Pack" }],
    });
    expect(plan.blocking).toBe(
      "Awish har redan en vara som heter Mystery Pack (id 6). Välj ett annat namn.",
    );
  });

  it("namnet hör redan till en annan titel i Binderlab: stoppas", () => {
    const plan = planEditGood({
      ...base,
      input: input({ name: "Mystery Pack" }),
      newNameTitle: title({ titleId: "t-2", titleName: "Mystery Pack" }),
    });
    expect(plan.blocking).toMatch(/hör redan till titeln Mystery Pack/);
  });

  it("annan titel heter redan det nya namnet: titeln byter inte namn, varning", () => {
    const plan = planEditGood({ ...base, input: input({ name: "Delta X" }), titleNameTaken: true });
    expect(plan.blocking).toBeNull();
    expect(plan.binderlab.renameTitle).toBeNull();
    expect(plan.warnings[0]).toMatch(/byter inte namn/);
  });

  it("kontot saknar behörighet, varan saknar SEK eller bild: stoppas", () => {
    expect(
      planEditGood({ ...base, input: input({ salePrice: "1" }), permissions: [] }).blocking,
    ).toMatch(/får inte ändra varor/);
    const usd = parseAwishGood({ ...RAW, prices: [RAW.prices[1]] });
    expect(planEditGood({ ...base, good: usd, input: input() }).blocking).toMatch(
      /inget pris i SEK/,
    );
    const noImage = parseAwishGood({ ...RAW, thumb: "", media: [] });
    expect(
      planEditGood({ ...base, good: noImage, input: input({ salePrice: "1" }) }).blocking,
    ).toBe("Awish kräver en bild på varan. Välj en bild.");
    expect(
      planEditGood({ ...base, good: noImage, input: input(), image: { fileName: "x.png" } })
        .blocking,
    ).toBeNull();
  });

  it("kontot får inte ändra fält som varan har värden i: stoppas, inget nollställs", () => {
    // RAW har ordinarie pris, medlemspris, kostnadspris och egenskaper. Panelen skickar 0 och
    // [] för dem utan behörighet, vilket skulle radera värdena i Awish.
    const plan = planEditGood({
      ...base,
      input: input({ salePrice: "160" }),
      permissions: [GOOD_PERMISSIONS.update],
    });
    expect(plan.blocking).toBe(
      "Awish-kontot får inte ändra varans ordinarie pris, medlemspris, kostnadspris och egenskaper. Att spara härifrån skulle nollställa dem i Awish. Ändra varan direkt i Awish.",
    );
    // Bara kostnadspris saknas i behörigheten: bara det nämns.
    expect(
      planEditGood({
        ...base,
        input: input({ salePrice: "160" }),
        permissions: ALL.filter((p) => p !== GOOD_PERMISSIONS.costPrice),
      }).blocking,
    ).toMatch(/^Awish-kontot får inte ändra varans kostnadspris\./);
    // Varan har inga sådana värden (som Ny produkt skapar dem): ingen behörighet behövs.
    const plain = parseAwishGood({
      ...RAW,
      attributes: [],
      prices: RAW.prices.map((p) => ({
        ...p,
        original_price: "0.00",
        member_price: "0.00",
        cost_price: "0.00",
      })),
    });
    expect(
      planEditGood({
        ...base,
        good: plain,
        input: input({ salePrice: "160" }),
        permissions: [GOOD_PERMISSIONS.update],
      }).blocking,
    ).toBeNull();
  });

  it("pris under inköpet varnar", () => {
    const plan = planEditGood({ ...base, input: input({ salePrice: "80" }) });
    expect(plan.warnings).toEqual(["Priset är lika med eller lägre än inköpspriset (90 kr)."]);
  });

  it("inte kopplad: säger det, inget alias", () => {
    const plan = planEditGood({ ...base, title: null, input: input({ name: "Ny" }) });
    expect(plan.binderlab.aliases).toEqual([]);
    expect(plan.lines).toContain(
      "Binderlab: varan är inte kopplad till någon titel. Koppla den i listan.",
    );
  });

  it("fingeravtrycket ändras om varan ändrats i Awish", () => {
    const plan = planEditGood({ ...base, input: input({ salePrice: "160" }) });
    const a = planFingerprint(plan, { good: good() });
    const b = planFingerprint(plan, { good: parseAwishGood({ ...RAW, slug: "annan" }) });
    expect(a).not.toBe(b);
    expect(planFingerprint(plan, { good: good() })).toBe(a);
  });
});

describe("checkEditedGood", () => {
  it("jämför det som skulle ändras med varan som lästes tillbaka", () => {
    const plan = planEditGood({
      good: good(),
      input: input({ name: "Delta Reign ETB", salePrice: "160" }),
      otherSameName: [],
      title: title(),
      newNameTitle: null,
      titleNameTaken: false,
      image: { fileName: "x.png" },
      permissions: ALL,
    });
    const after = parseAwishGood({
      ...RAW,
      name: "Delta Reign ETB",
      thumb: "https://img.example/ny.png",
      prices: [{ ...RAW.prices[0], price: "160.00" }],
    });
    expect(checkEditedGood(plan, after, "https://img.example/ny.png").all).toBe(true);
    const stale = checkEditedGood(plan, good(), "https://img.example/ny.png");
    expect(stale).toEqual({ found: true, name: false, price: false, image: false, all: false });
    expect(notSavedText(stale)).toBe("namnet, priset och bilden");
    expect(checkEditedGood(plan, null, null).found).toBe(false);
  });
});
