/**
 * Rena delar av katalogen i Awish: priser i öre → "79.00", panelens vara → API:ts vara
 * (SEK-valutan), "Ta bort vara" spärras när varan ligger i ett fack, kategoriändringar,
 * medlemmar (bara fältnamn i loggen) och tidszonen (UpdateMerchant med bara timezone).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { orePriceText, webGoodToApiInput, placementsOf, planDeleteGood } =
  await import("./goods-api");
const { sekCurrency, currencyLabel } = await import("./currencies");
const { parseCategoryChange, planCategoryChange } = await import("./categories");
const { fieldNames, memberPatch, parseNewMember, memberStatusLabel } = await import("./members");
const { planTimezone } = await import("./merchant");
const { encodeGoodInput } = await import("../awish/goods");
const { canonicalBody } = await import("../awish/sign");

const CURRENCIES = [
  { id: "1", name: "Swedish krona", code: "SEK", symbol: "kr" },
  { id: "2", name: "US dollar", code: "USD", symbol: "$" },
];

describe("priser", () => {
  it("öre → text med två decimaler", () => {
    expect(orePriceText(7900)).toBe("79.00");
    expect(orePriceText(7950)).toBe("79.50");
    expect(orePriceText(5)).toBe("0.05");
    expect(orePriceText(0)).toBe("0.00");
    expect(orePriceText(1_000_000)).toBe("10000.00");
    expect(() => orePriceText(-1)).toThrow(RangeError);
    expect(() => orePriceText(1.5)).toThrow(RangeError);
  });

  it("SEK i valutorna", () => {
    expect(sekCurrency(CURRENCIES)?.id).toBe("1");
    expect(sekCurrency([{ id: "9", name: "x", code: " sek ", symbol: "" }])?.id).toBe("9");
    expect(sekCurrency([CURRENCIES[1]!])).toBeNull();
    expect(currencyLabel(CURRENCIES[0]!)).toBe("SEK · kr");
  });
});

describe("panelens vara → API:ts vara", () => {
  it("ny vara: priset som text, SEK-id från Awish, bara API:ts fält", () => {
    const web = encodeGoodInput({
      name: "Mystery XL",
      salePriceOre: 7900,
      currencyId: 1,
      imageUrl: "https://x/a.png",
    });
    const api = webGoodToApiInput(web, CURRENCIES);
    expect(api).toEqual({
      name: "Mystery XL",
      description: "Mystery XL",
      prices: [{ id: "0", price: "79.00", currencyId: "1" }],
      media: ["https://x/a.png"],
      thumb: "https://x/a.png",
      content: "<p>Mystery XL</p>",
      isTaxExempt: true,
      taxRate: "0",
      isReturnable: false,
    });
    expect(Object.keys(api)).not.toContain("slug");
    expect(Object.keys(api)).not.toContain("attributes");
  });

  it("okänd valuta i panelen blir SEK; saknas SEK nekas varan", () => {
    const web = encodeGoodInput({ name: "A", salePriceOre: 100, currencyId: 77, imageUrl: null });
    expect(webGoodToApiInput(web, CURRENCIES).prices[0]!.currencyId).toBe("1");
    expect(() => webGoodToApiInput(web, [CURRENCIES[1]!])).toThrow(/SEK/);
  });

  it("ordinarie pris och medlemspris skickas bara när de inte är 0", () => {
    const web = encodeGoodInput({ name: "A", salePriceOre: 100, currencyId: 1, imageUrl: null });
    web.prices[0]!.member_price = 89.5;
    const price = webGoodToApiInput(web, CURRENCIES).prices[0]!;
    expect(price).toEqual({ id: "0", price: "1.00", currencyId: "1", memberPrice: "89.50" });
  });

  it("varan går att signera (CreateGoodRequest, nästlade priser sorterade, id 0 som standard)", () => {
    const api = webGoodToApiInput(
      encodeGoodInput({ name: "Åäö 宝", salePriceOre: 7900, currencyId: 1, imageUrl: null }),
      CURRENCIES,
    );
    const body = canonicalBody(
      "CreateGoodRequest",
      {
        name: api.name,
        description: api.description,
        prices: api.prices.map((p) => ({ id: p.id, price: p.price, currency_id: p.currencyId })),
      },
      "present_sorted",
    );
    expect(body).toBe(
      '{"description":"Åäö 宝","name":"Åäö 宝","prices":[{"currency_id":1,"price":"79.00"}]}',
    );
  });
});

describe("Ta bort vara", () => {
  const machine = { machineId: "m", code: "BL-003", name: "Sega gubben", awishMachineId: "123" };
  const product = (id: string, goodId: string | null, name: string) => ({
    id,
    machineId: "123",
    status: true,
    floorStatus: null,
    lockStatus: null,
    currentInventory: 4,
    capacity: 10,
    goodId,
    goodName: goodId ? "Mystery Pack" : null,
    channel: { id, name, addr: "1", motorId: id, floorType: 2, total: 10 },
  });

  it("spärras när varan ligger i ett fack", () => {
    const placements = placementsOf("9", [
      { machine, products: [product("71", "9", "A3"), product("72", "8", "A4")] },
    ]);
    expect(placements).toEqual([{ machine: "BL-003", slot: "A3" }]);
    const plan = planDeleteGood({ goodName: "Mystery Pack", placements });
    expect(plan.blocking).toBe("Varan ligger i A3 på BL-003. Byt pack i facket först.");
    expect(plan.confirm).toBeNull();
  });

  it("fler fack sägs; utan fack frågas det", () => {
    const placements = placementsOf("9", [
      { machine, products: [product("71", "9", "A3"), product("72", "9", "A4")] },
    ]);
    expect(planDeleteGood({ goodName: "X", placements }).blocking).toBe(
      "Varan ligger i A3 på BL-003 och 1 fack till. Byt pack i facket först.",
    );
    const free = planDeleteGood({ goodName: "Mystery Pack", placements: [] });
    expect(free.blocking).toBeNull();
    expect(free.lines).toEqual(["Mystery Pack tas bort i Awish."]);
    expect(free.confirm).toMatch(/Varan tas bort i Awish/);
  });
});

describe("kategorier", () => {
  const cats = [
    { id: "1", title: "Pokémon" },
    { id: "2", title: "Mystery" },
  ];

  it("ny kategori: namn krävs, dubblett spärras, synlig som standard", () => {
    expect(() => parseCategoryChange({ action: "create", title: "  " })).toThrow(/Skriv ett namn/);
    expect(() => parseCategoryChange({ action: "create", title: "x".repeat(41) })).toThrow(/40/);
    const c = parseCategoryChange({ action: "create", title: " Nytt ", priority: "3" });
    expect(c).toEqual({ action: "create", title: "Nytt", priority: 3, isVisible: true });
    expect(planCategoryChange(c, cats)).toEqual({
      lines: ["Ny kategori Nytt.", "Ordning 3.", "Visas på skärmen."],
      blocking: null,
      confirm: null,
    });
    const dup = parseCategoryChange({ action: "create", title: "mystery" });
    expect(planCategoryChange(dup, cats).blocking).toBe(
      "Det finns redan en kategori som heter Mystery.",
    );
  });

  it("ändra: bara det som ändras; ingenting ändrat spärras", () => {
    expect(() => parseCategoryChange({ action: "update", id: "1" })).toThrow("Inget är ändrat.");
    const c = parseCategoryChange({
      action: "update",
      id: "1",
      title: "Pokemon",
      isVisible: "nej",
    });
    expect(planCategoryChange(c, cats).lines).toEqual([
      "Pokémon:",
      "Pokémon → Pokemon.",
      "Visas inte på skärmen.",
    ]);
    expect(() => parseCategoryChange({ action: "update", id: "1", priority: "-1" })).toThrow(
      /Ordningen/,
    );
  });

  it("ta bort frågar; en okänd kategori spärras", () => {
    expect(planCategoryChange({ action: "delete", id: "2" }, cats).confirm).toMatch(
      /Ta bort Mystery\?/,
    );
    expect(planCategoryChange({ action: "delete", id: "3" }, cats).blocking).toMatch(/finns inte/);
    expect(() => parseCategoryChange({ action: "delete", id: "abc" })).toThrow("Välj kategori.");
  });
});

describe("medlemmar", () => {
  const current = {
    id: "5",
    name: "Anna Andersson",
    telMasked: "070****123",
    emailMasked: "a***@x.se",
    memberNo: "M1",
    machineId: null,
    principalBalance: "10.00",
    bonusBalance: "0.00",
    totalBalance: "10.00",
    points: 0,
    levelId: 1,
    status: 1,
    registeredAt: "2026-11-01 10:00:00",
    remark: null,
  };

  it("ny medlem: namn krävs, telefon och e-post kontrolleras, aldrig saldo eller lösenord", () => {
    expect(() => parseNewMember({ name: "" })).toThrow("Skriv ett namn.");
    expect(() => parseNewMember({ name: "A", email: "inte-epost" })).toThrow(/E-postadressen/);
    expect(() => parseNewMember({ name: "A", tel: "abc" })).toThrow(/Telefonnumret/);
    const m = parseNewMember({
      name: " Anna ",
      tel: "070-123 45 67",
      email: "anna@example.se",
      status: "1",
      principalBalance: "1000",
      password: "123456",
    });
    expect(m).toEqual({ name: "Anna", tel: "070-123 45 67", email: "anna@example.se", status: 1 });
  });

  it("ändring: bara fält som skiljer sig; loggen får bara fältnamnen", () => {
    const patch = memberPatch(current, {
      name: "Anna Andersson",
      memberNo: "M2",
      status: "2",
      remark: "VIP",
    });
    expect(patch).toEqual({ memberNo: "M2", status: 2, remark: "VIP" });
    const fields = fieldNames(patch);
    expect(fields).toEqual(["memberNo", "remark", "status"]);
    expect(JSON.stringify(fields)).not.toMatch(/M2|VIP|Anna/);
    expect(memberPatch(current, { name: "Anna Andersson" })).toEqual({});
  });

  it("status", () => {
    expect([0, 1, 2, 7].map(memberStatusLabel)).toEqual(["Av", "Aktiv", "Fryst", "Okänd"]);
  });
});

describe("tidszon", () => {
  it("byte frågas; samma tidszon spärras", () => {
    const plan = planTimezone({ current: "Asia/Shanghai", wanted: "Europe/Stockholm" });
    expect(plan.lines).toEqual(["Tidszon: Asia/Shanghai → Europe/Stockholm."]);
    expect(plan.confirm).toMatch(/Europe\/Stockholm/);
    expect(
      planTimezone({ current: "Europe/Stockholm", wanted: "Europe/Stockholm" }).blocking,
    ).toMatch(/redan/);
  });

  it("UpdateMerchant signeras med bara timezone (aldrig config)", () => {
    expect(
      canonicalBody("UpdateMerchantRequest", { timezone: "Europe/Stockholm" }, "present_sorted"),
    ).toBe('{"timezone":"Europe/Stockholm"}');
  });
});
