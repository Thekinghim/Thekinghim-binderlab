import { describe, expect, it } from "vitest";

import {
  awishPriceToOre,
  checkGoodImage,
  encodeGoodInput,
  formatKr,
  goodNameKey,
  newProductInputSchema,
  oreToAwishPrice,
  parseKronor,
  planFingerprint,
  planNewProduct,
  planSlotChange,
  slotChangeInputSchema,
  sniffGoodImage,
  type AwishSlot,
  type NewProductInput,
} from "./goods";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

describe("priser", () => {
  it("läser kronor som användaren skriver dem", () => {
    expect(parseKronor("79")).toBe(7900);
    expect(parseKronor("79,5")).toBe(7950);
    expect(parseKronor("79.50")).toBe(7950);
    expect(parseKronor(" 1 200 kr")).toBe(120000);
    expect(parseKronor(79.5)).toBe(7950);
    expect(parseKronor("79,505")).toBeNull();
    expect(parseKronor("-5")).toBeNull();
    expect(parseKronor("abc")).toBeNull();
    expect(parseKronor(null)).toBeNull();
    expect(parseKronor(Number.NaN)).toBeNull();
  });

  it("öre ↔ Awishs pris (tal i kronor, decimalsträng tillbaka)", () => {
    expect(oreToAwishPrice(7900)).toBe(79);
    expect(oreToAwishPrice(7950)).toBe(79.5);
    expect(oreToAwishPrice(1)).toBe(0.01);
    expect(() => oreToAwishPrice(-1)).toThrow();
    expect(() => oreToAwishPrice(1.5)).toThrow();
    expect(awishPriceToOre("79.00")).toBe(7900);
    expect(awishPriceToOre("79.5")).toBe(7950);
    expect(awishPriceToOre(12.34)).toBe(1234);
    expect(awishPriceToOre(null)).toBeNull();
    expect(awishPriceToOre("x")).toBeNull();
    expect(formatKr(7900)).toBe("79 kr");
    expect(formatKr(7950)).toBe("79,50 kr");
    expect(formatKr(120000)).toBe("1 200 kr");
  });
});

describe("formuläret", () => {
  const ok = {
    name: "  Mystery   Pack ",
    salePrice: "79",
    purchasePrice: "35,50",
    ownProduct: true,
  };

  it("rensar namnet och gör om priserna till öre", () => {
    const r = newProductInputSchema.parse(ok);
    expect(r).toEqual({
      name: "Mystery Pack",
      salePrice: 7900,
      purchasePrice: 3550,
      ownProduct: true,
    });
  });

  it("nekar pris 0, negativt, för högt och tomt namn med svenska fel", () => {
    const err = (v: Record<string, unknown>) =>
      newProductInputSchema.safeParse({ ...ok, ...v }).error?.issues[0]?.message;
    expect(err({ salePrice: "0" })).toBe("Försäljningspriset måste vara mer än 0 kr.");
    expect(err({ salePrice: "-3" })).toMatch(/Skriv försäljningspriset/);
    expect(err({ salePrice: "10001" })).toBe("Försäljningspriset får vara högst 10 000 kr.");
    expect(err({ purchasePrice: "20000" })).toBe("Inköpspriset får vara högst 10 000 kr.");
    expect(err({ name: "   " })).toBe("Skriv ett namn.");
    expect(err({ name: "a".repeat(101) })).toMatch(/högst 100 tecken/);
    expect(err({ name: "rad\u0007" })).toMatch(/radbrytningar/);
    expect(newProductInputSchema.safeParse({ ...ok, purchasePrice: "0" }).success).toBe(true);
  });

  it("fackbytet: antal är valfritt, heltal och högst 999", () => {
    const base = { machineId: "6f1c0d1e-8a3b-4f2a-9c1d-2b3e4f5a6b7c", productId: "11", goodId: 5 };
    expect(slotChangeInputSchema.parse({ ...base, count: "" }).count).toBeNull();
    expect(slotChangeInputSchema.parse({ ...base, count: "4" }).count).toBe(4);
    expect(slotChangeInputSchema.safeParse({ ...base, count: "2.5" }).success).toBe(false);
    expect(slotChangeInputSchema.safeParse({ ...base, count: "-1" }).success).toBe(false);
    expect(slotChangeInputSchema.safeParse({ ...base, count: "1000" }).success).toBe(false);
    expect(slotChangeInputSchema.safeParse({ ...base, machineId: "x" }).success).toBe(false);
  });
});

describe("bilden", () => {
  it("typen läses ur innehållet", () => {
    expect(sniffGoodImage(PNG)).toBe("image/png");
    expect(sniffGoodImage(JPG)).toBe("image/jpeg");
    expect(sniffGoodImage(WEBP)).toBe("image/webp");
    expect(sniffGoodImage(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });

  it("filnamnet byggs av varans namn, inte användarens fil", () => {
    const img = checkGoodImage(JPG, "Pokémon Mystery Pack!");
    expect(img.fileName).toBe("pokemon-mystery-pack.jpg");
    expect(img.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => checkGoodImage(new Uint8Array(), "x")).toThrow("Bilden är tom.");
    expect(() => checkGoodImage(new Uint8Array(5 * 1024 * 1024), "x")).toThrow(/för stor/);
    expect(() => checkGoodImage(new TextEncoder().encode("GIF89a"), "x")).toThrow(
      /jpg, png eller webp/,
    );
  });
});

describe("encodeGoodInput (panelens GoodInput)", () => {
  it("har exakt panelens fält, i panelens ordning, med priset som tal", () => {
    const input = encodeGoodInput({
      name: "Mystery <Pack>",
      salePriceOre: 7950,
      currencyId: 2,
      imageUrl: "https://dash.awish.vip/uploads/a.jpg",
    });
    expect(Object.keys(input)).toEqual([
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
    expect(input).toEqual({
      name: "Mystery <Pack>",
      description: "Mystery <Pack>",
      thumb: "https://dash.awish.vip/uploads/a.jpg",
      content: "<p>Mystery &lt;Pack&gt;</p>",
      media: ["https://dash.awish.vip/uploads/a.jpg"],
      multi_currency_enabled: false,
      slug: "",
      unit_id: null,
      attributes: [],
      is_tax_exempt: true,
      tax_rate: 0,
      is_returnable: false,
      prices: [
        { id: 0, currency_id: 2, price: 79.5, original_price: 0, member_price: 0, cost_price: 0 },
      ],
    });
    // Inköpspriset skickas aldrig till Awish.
    expect(JSON.stringify(input)).not.toMatch(/cost_price":[1-9]/);
  });

  it("utan bild: tom media och tom thumb", () => {
    const input = encodeGoodInput({ name: "X", salePriceOre: 100, currencyId: 2, imageUrl: null });
    expect(input.media).toEqual([]);
    expect(input.thumb).toBe("");
  });

  it("nekar pris 0 och saknad valuta", () => {
    expect(() =>
      encodeGoodInput({ name: "X", salePriceOre: 0, currencyId: 2, imageUrl: null }),
    ).toThrow(/mer än 0 kr/);
    expect(() =>
      encodeGoodInput({ name: "X", salePriceOre: 100, currencyId: 0, imageUrl: null }),
    ).toThrow(/SEK/);
    expect(() =>
      encodeGoodInput({ name: " ", salePriceOre: 100, currencyId: 2, imageUrl: null }),
    ).toThrow(/namn/);
  });
});

describe("planNewProduct", () => {
  const input: NewProductInput = {
    name: "Mystery Pack",
    salePrice: 7900,
    purchasePrice: 3500,
    ownProduct: false,
  };

  it("ny vara och ny titel: visar varan, priset, titeln och inköpspriset", () => {
    const plan = planNewProduct({
      input,
      sameNameGoods: [],
      title: null,
      image: { fileName: "mystery-pack.jpg", bytes: 1000 },
      today: "2026-11-05",
    });
    expect(plan.awish).toEqual({ action: "create", priceOre: 7900, image: "mystery-pack.jpg" });
    expect(plan.title).toEqual({ action: "create" });
    expect(plan.alias).toBe("create");
    expect(plan.purchasePrice).toEqual({ action: "set", ore: 3500, validFrom: "2026-11-05" });
    expect(plan.ownProduct).toEqual({ action: "keep", value: false });
    expect(plan.blocking).toBeNull();
    expect(plan.nothingToDo).toBe(false);
    expect(plan.lines).toEqual([
      "Awish: ny vara Mystery Pack, 79 kr, bild mystery-pack.jpg.",
      "Binderlab: ny titel Mystery Pack.",
      "Inköpspris 35 kr från 2026-11-05.",
    ]);
  });

  it("varan finns redan i Awish: skapas inte, priset ändras inte, bara koppling", () => {
    const plan = planNewProduct({
      input,
      sameNameGoods: [{ id: 9, name: "mystery  pack", priceOre: 6900, thumb: null }],
      title: null,
      image: { fileName: "a.jpg", bytes: 1 },
      today: "2026-11-05",
    });
    expect(plan.awish).toEqual({ action: "exists", goodId: 9, priceOre: 6900 });
    expect(plan.warnings).toContain(
      "Awish har redan mystery  pack för 69 kr. Priset ändras inte här.",
    );
    expect(plan.warnings).toContain("Varan finns redan i Awish. Bilden skickas inte.");
    expect(plan.lines[0]).toBe("Awish: Mystery Pack finns redan (id 9). Ingen ändring i Awish.");
  });

  it("två varor med samma namn i Awish stoppar", () => {
    const plan = planNewProduct({
      input,
      sameNameGoods: [
        { id: 9, name: "Mystery Pack", priceOre: 7900, thumb: null },
        { id: 10, name: "Mystery Pack", priceOre: 7900, thumb: null },
      ],
      title: null,
      image: null,
      today: "2026-11-05",
    });
    expect(plan.blocking).toMatch(/2 varor som heter Mystery Pack/);
  });

  it("befintlig titel med pris: inköpspriset behålls (ändras under Inköpspriser)", () => {
    const plan = planNewProduct({
      input: { ...input, ownProduct: true },
      sameNameGoods: [],
      title: {
        titleId: "t1",
        titleName: "Mystery Pack",
        hasAlias: false,
        archived: false,
        ownProduct: false,
        purchasePriceOre: 3000,
      },
      image: null,
      today: "2026-11-05",
    });
    expect(plan.purchasePrice).toEqual({ action: "keep", currentOre: 3000 });
    expect(plan.alias).toBe("create");
    expect(plan.ownProduct).toEqual({ action: "set", value: true });
    expect(plan.warnings[0]).toMatch(/redan inköpspris 30 kr/);
    expect(plan.lines).toContain("Binderlab: kopplar Mystery Pack till titeln Mystery Pack.");
    expect(plan.lines).toContain("Egen produkt: ja.");
  });

  it("befintlig egen produkt slås aldrig av härifrån (behålls, med varning)", () => {
    const plan = planNewProduct({
      input: { ...input, ownProduct: false },
      sameNameGoods: [],
      title: {
        titleId: "t1",
        titleName: "Mystery Pack",
        hasAlias: true,
        archived: false,
        ownProduct: true,
        purchasePriceOre: 3500,
      },
      image: null,
      today: "2026-11-05",
    });
    expect(plan.ownProduct).toEqual({ action: "keep", value: true });
    expect(plan.lines).not.toContain("Egen produkt: nej (köps in).");
    expect(plan.warnings).toContain(
      "Mystery Pack är Egen produkt i Binderlab. Det ändras inte här (ändra under Inköpspriser).",
    );
  });

  it("allt finns redan: inget att skicka", () => {
    const plan = planNewProduct({
      input,
      sameNameGoods: [{ id: 9, name: "Mystery Pack", priceOre: 7900, thumb: null }],
      title: {
        titleId: "t1",
        titleName: "Mystery Pack",
        hasAlias: true,
        archived: false,
        ownProduct: false,
        purchasePriceOre: 3500,
      },
      image: null,
      today: "2026-11-05",
    });
    expect(plan.nothingToDo).toBe(true);
    expect(plan.warnings).toEqual([]);
  });

  it("arkiverad titel stoppar, och inköp ≥ försäljning varnar", () => {
    const plan = planNewProduct({
      input: { ...input, purchasePrice: 9000 },
      sameNameGoods: [],
      title: {
        titleId: "t1",
        titleName: "Mystery Pack",
        hasAlias: true,
        archived: true,
        ownProduct: false,
        purchasePriceOre: null,
      },
      image: null,
      today: "2026-11-05",
    });
    expect(plan.blocking).toMatch(/arkiverad/);
    expect(plan.warnings).toContain(
      "Inköpspriset är lika högt som eller högre än försäljningspriset.",
    );
  });

  it("fingeravtrycket ändras när planen ändras, inte av nyckelordning", () => {
    const a = planFingerprint({ x: 1, y: [1, { b: 2, a: 1 }] }, { image: null });
    const b = planFingerprint({ y: [1, { a: 1, b: 2 }], x: 1 }, { image: null });
    const c = planFingerprint({ x: 2, y: [1, { a: 1, b: 2 }] }, { image: null });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("namnnyckeln är samma som title_aliases.alias_normalized", () => {
    expect(goodNameKey("  Mystery\tPACK ")).toBe("mystery pack");
    expect(goodNameKey("Ｍystery")).toBe("mystery");
  });
});

describe("planSlotChange", () => {
  const slot: AwishSlot = {
    id: 11,
    channelName: "A1",
    goodId: 6,
    goodName: "Mystery Pack",
    status: true,
    floorStatus: "ERR_NORMAL",
    currentInventory: 5,
    capacity: 10,
  };
  const other = { id: 7, name: "30th Celebration" };

  it("byte av vara i ett fack med pack kräver bekräftelse", () => {
    const plan = planSlotChange({ slot, good: other, count: 8 });
    expect(plan.confirm).toBe("Fack A1 har 5 Mystery Pack – byt ändå?");
    expect(plan.to).toEqual({ goodId: 7, goodName: "30th Celebration", count: 8 });
    expect(plan.from).toEqual({ goodId: 6, goodName: "Mystery Pack", count: 5 });
    expect(plan.lines).toEqual(["Fack A1: Mystery Pack 5 st → 30th Celebration 8 st."]);
  });

  it("byte utan antal: 0 st (och fortfarande bekräftelse)", () => {
    const plan = planSlotChange({ slot, good: other, count: null });
    expect(plan.to.count).toBe(0);
    expect(plan.confirm).not.toBeNull();
  });

  it("tomt fack: ingen bekräftelse", () => {
    const plan = planSlotChange({
      slot: { ...slot, goodId: null, goodName: null, currentInventory: 0 },
      good: other,
      count: 4,
    });
    expect(plan.confirm).toBeNull();
    expect(plan.lines).toEqual(["Fack A1: tomt → 30th Celebration 4 st."]);
  });

  it("samma vara: lägre antal kräver bekräftelse, högre inte, samma = inget att ändra", () => {
    expect(planSlotChange({ slot, good: { id: 6, name: "Mystery Pack" }, count: 2 }).confirm).toBe(
      "Fack A1 har 5 Mystery Pack. Sänk till 2?",
    );
    expect(
      planSlotChange({ slot, good: { id: 6, name: "Mystery Pack" }, count: 9 }).confirm,
    ).toBeNull();
    const same = planSlotChange({ slot, good: { id: 6, name: "Mystery Pack" }, count: null });
    expect(same.unchanged).toBe(true);
    expect(same.lines).toEqual(["Fack A1: Mystery Pack 5 st. Inget att ändra."]);
  });

  it("över kapaciteten eller fack med fel stoppar; avstängt fack varnar", () => {
    expect(planSlotChange({ slot, good: other, count: 11 }).blocking).toBe(
      "Fack A1 rymmer 10. Välj högst 10.",
    );
    expect(
      planSlotChange({ slot: { ...slot, floorStatus: "ERR_MOTOR_FAULT" }, good: other, count: 1 })
        .blocking,
    ).toMatch(/fel i Awish/);
    expect(
      planSlotChange({ slot: { ...slot, status: false }, good: other, count: 1 }).warnings,
    ).toEqual(["Fack A1 är avstängt i Awish och säljer inte."]);
  });

  it("fack utan vara men med antal: byte kräver bekräftelse och visas inte som tomt", () => {
    const plan = planSlotChange({
      slot: { ...slot, goodId: null, goodName: null, currentInventory: 3 },
      good: other,
      count: 4,
    });
    expect(plan.confirm).toBe("Fack A1 har 3 pack – byt ändå?");
    expect(plan.lines).toEqual(["Fack A1: utan vara 3 st → 30th Celebration 4 st."]);
  });

  it("statusen behålls", () => {
    expect(planSlotChange({ slot: { ...slot, status: false }, good: other, count: 1 }).status).toBe(
      false,
    );
  });
});
