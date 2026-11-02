import { describe, expect, it } from "vitest";

import {
  agreementChangeImpact,
  checkAgreementEnd,
  newAgreementImpact,
  newAgreementSchema,
  parsePercentBp,
  parseRentOre,
  planNewAgreement,
  recipientSchema,
  storeSchema,
  updateAgreementSchema,
} from "./validation";

const STORE = "6178a492-31f6-4a5b-a7d0-ad92e1859ce5";

describe("parsePercentBp", () => {
  it("tolkar heltal, decimalkomma, punkt och procenttecken", () => {
    expect(parsePercentBp("12")).toEqual({ ok: true, value: 1200 });
    expect(parsePercentBp("12,5")).toEqual({ ok: true, value: 1250 });
    expect(parsePercentBp("12.25 %")).toEqual({ ok: true, value: 1225 });
    expect(parsePercentBp(" 0 ")).toEqual({ ok: true, value: 0 });
    expect(parsePercentBp("100")).toEqual({ ok: true, value: 10_000 });
  });
  it("tomt fält är ingen provision", () => {
    expect(parsePercentBp("")).toEqual({ ok: true, value: null });
    expect(parsePercentBp(undefined)).toEqual({ ok: true, value: null });
  });
  it("nekar över 100 %, tre decimaler och text", () => {
    expect(parsePercentBp("100,01").ok).toBe(false);
    expect(parsePercentBp("12,345").ok).toBe(false);
    expect(parsePercentBp("tolv").ok).toBe(false);
    expect(parsePercentBp("-5").ok).toBe(false);
  });
});

describe("parseRentOre", () => {
  it("tolkar kronor till öre", () => {
    expect(parseRentOre("750")).toEqual({ ok: true, value: 75_000 });
    expect(parseRentOre("1 500,50 kr")).toEqual({ ok: true, value: 150_050 });
    expect(parseRentOre("")).toEqual({ ok: true, value: null });
  });
  it("nekar text", () => {
    expect(parseRentOre("mycket").ok).toBe(false);
  });
});

describe("scheman", () => {
  it("butik: namn krävs, tomma fält blir null, e-post kontrolleras", () => {
    expect(storeSchema.safeParse({ name: " " }).success).toBe(false);
    const ok = storeSchema.parse({ name: " ICA ", address: "", email: "", isExample: "on" });
    expect(ok).toMatchObject({ name: "ICA", address: null, email: null, isExample: true });
    expect(storeSchema.safeParse({ name: "ICA", email: "inte-en-adress" }).success).toBe(false);
    expect(storeSchema.safeParse({ name: "ICA", phone: "046-12 34 56" }).success).toBe(true);
    expect(storeSchema.safeParse({ name: "ICA", phone: "ring mig" }).success).toBe(false);
  });
  it("nytt avtal: minst provision eller hyra, slut efter start", () => {
    const none = newAgreementSchema.safeParse({ storeId: STORE, validFrom: "2026-11-01" });
    expect(none.success).toBe(false);
    expect(none.error?.issues[0]?.message).toBe("Ange provision, hyra eller båda.");
    const both = newAgreementSchema.parse({
      storeId: STORE,
      validFrom: "2026-11-01",
      validTo: "",
      commission: "8",
      rent: "750",
    });
    expect(both).toMatchObject({ commissionBp: 800, monthlyRentOre: 75_000, validTo: null });
    expect(
      newAgreementSchema.safeParse({
        storeId: STORE,
        validFrom: "2026-11-01",
        validTo: "2026-10-31",
        commission: "8",
      }).success,
    ).toBe(false);
    expect(
      newAgreementSchema.safeParse({ storeId: "x", validFrom: "2026-11-01", commission: "8" })
        .success,
    ).toBe(false);
  });
  it("ändrat avtal: villkoren tolkas på samma sätt", () => {
    const v = updateAgreementSchema.parse({ agreementId: STORE, commission: "", rent: "900" });
    expect(v).toMatchObject({ commissionBp: null, monthlyRentOre: 90_000, confirmHistory: false });
    // Utelämnad sista dag = oförändrad; tom = tills vidare.
    expect(v.validTo).toBeUndefined();
    expect(
      updateAgreementSchema.parse({ agreementId: STORE, rent: "1", validTo: "" }).validTo,
    ).toBe(null);
    expect(
      updateAgreementSchema.parse({ agreementId: STORE, rent: "1", validTo: "2026-12-31" }).validTo,
    ).toBe("2026-12-31");
  });
  it("mottagare: e-post krävs", () => {
    expect(recipientSchema.safeParse({ storeId: STORE, name: "Anna", email: "" }).success).toBe(
      false,
    );
    expect(
      recipientSchema.parse({ storeId: STORE, name: " Anna ", email: " anna@example.se " }),
    ).toMatchObject({ name: "Anna", email: "anna@example.se" });
  });
});

describe("planNewAgreement", () => {
  const open = { id: "a", validFrom: "2026-10-01", validTo: null };

  it("utan tidigare avtal: inget att avsluta", () => {
    expect(planNewAgreement([], "2026-11-01", null)).toEqual({ ok: true, close: null });
  });
  it("avslutar det gällande avtalet dagen före", () => {
    expect(planNewAgreement([open], "2026-11-15", null)).toEqual({
      ok: true,
      close: { id: "a", validTo: "2026-11-14" },
    });
  });
  it("ett avtal som redan slutat före rörs inte", () => {
    const ended = { id: "a", validFrom: "2026-01-01", validTo: "2026-06-30" };
    expect(planNewAgreement([ended], "2026-07-01", null)).toEqual({ ok: true, close: null });
  });
  it("samma startdag stoppas", () => {
    const r = planNewAgreement([open], "2026-10-01", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflictId).toBe("a");
  });
  it("ett senare avtal stoppar ett tillsvidareavtal men inte ett som slutar före", () => {
    const later = { id: "b", validFrom: "2026-12-01", validTo: null };
    const blocked = planNewAgreement([later], "2026-11-01", null);
    expect(blocked.ok).toBe(false);
    expect(planNewAgreement([later], "2026-11-01", "2026-11-30")).toEqual({
      ok: true,
      close: null,
    });
  });
  it("klyver inte ett avtal som fortsätter efter det nya", () => {
    const fixed = { id: "a", validFrom: "2026-01-01", validTo: "2026-12-31" };
    expect(planNewAgreement([fixed], "2026-06-01", "2026-06-30").ok).toBe(false);
    expect(planNewAgreement([fixed], "2026-06-01", null)).toEqual({
      ok: true,
      close: { id: "a", validTo: "2026-05-31" },
    });
  });
});

describe("checkAgreementEnd", () => {
  const list = [
    { id: "a", validFrom: "2026-10-01", validTo: "2026-11-30" },
    { id: "b", validFrom: "2026-12-01", validTo: null },
  ];
  it("tillåter slut före nästa avtal", () => {
    expect(checkAgreementEnd(list, "a", "2026-11-15")).toBeNull();
    expect(checkAgreementEnd(list, "b", null)).toBeNull();
  });
  it("nekar överlapp med nästa avtal och slut före start", () => {
    expect(checkAgreementEnd(list, "a", "2026-12-01")).toMatch(/Nästa avtal/);
    expect(checkAgreementEnd(list, "a", null)).toMatch(/Nästa avtal/);
    expect(checkAgreementEnd(list, "a", "2026-09-30")).toMatch(/före det börjar/);
    expect(checkAgreementEnd(list, "x", null)).toBe("Avtalet finns inte.");
  });
});

describe("ändringar bakåt i tiden", () => {
  const TODAY = "2026-11-02";
  const a = {
    validFrom: "2026-10-01",
    validTo: null,
    commissionBp: 1_000,
    monthlyRentOre: null,
  } as const;

  it("nytt avtal: bara dagar före i dag räknas om", () => {
    expect(newAgreementImpact("2026-11-02", null, TODAY)).toBeNull();
    expect(newAgreementImpact("2026-12-01", null, TODAY)).toBeNull();
    expect(newAgreementImpact("2026-10-15", null, TODAY)).toEqual({
      start: "2026-10-15",
      end: "2026-11-01",
    });
    expect(newAgreementImpact("2026-10-15", "2026-10-20", TODAY)).toEqual({
      start: "2026-10-15",
      end: "2026-10-20",
    });
  });

  it("rättning: villkor bakåt till start, sista dag mellan gammalt och nytt slut", () => {
    // Bara anteckningen: inget räknas om.
    expect(agreementChangeImpact(a, { ...a }, TODAY)).toBeNull();
    // Nya villkor på ett avtal som började 1 okt.
    expect(agreementChangeImpact(a, { ...a, commissionBp: 1_200 }, TODAY)).toEqual({
      start: "2026-10-01",
      end: "2026-11-01",
    });
    // Sista dagen i framtiden påverkar inte passerade dagar.
    expect(agreementChangeImpact(a, { ...a, validTo: "2026-12-31" }, TODAY)).toBeNull();
    // Sista dagen bakåt: dagarna efter den nya sista dagen till i går.
    expect(agreementChangeImpact(a, { ...a, validTo: "2026-10-20" }, TODAY)).toEqual({
      start: "2026-10-21",
      end: "2026-11-01",
    });
    // Ett avslutat avtal förlängs: dagarna mellan gammalt och nytt slut.
    expect(
      agreementChangeImpact(
        { ...a, validTo: "2026-10-10" },
        { ...a, validTo: "2026-10-20" },
        TODAY,
      ),
    ).toEqual({ start: "2026-10-11", end: "2026-10-20" });
    // Ett kommande avtal kan rättas fritt.
    const upcoming = { ...a, validFrom: "2026-12-01" };
    expect(
      agreementChangeImpact(upcoming, { ...upcoming, monthlyRentOre: 50_000 }, TODAY),
    ).toBeNull();
  });
});
