import { describe, expect, it } from "vitest";

import {
  luhnValid,
  parseBankgiro,
  parseOrgNumber,
  parsePostalCode,
  parseVatNumber,
  vatFromOrgNumber,
} from "./swedish-ids";

describe("organisationsnummer", () => {
  it("normaliseras till NNNNNN-NNNN oavsett hur det skrivs", () => {
    for (const raw of ["559900-1236", "5599001236", " 559900 1236 ", "16559900-1236"]) {
      expect(parseOrgNumber(raw)).toEqual({ ok: true, value: "559900-1236" });
    }
  });

  it("enskild firma: personnummer med sekel blir tio siffror", () => {
    expect(parseOrgNumber("19800101-0118")).toEqual({ ok: true, value: "800101-0118" });
  });

  it("fel kontrollsiffra, fel längd och bokstäver nekas", () => {
    expect(parseOrgNumber("559900-1237")).toEqual({
      ok: false,
      message: "Organisationsnumret stämmer inte. Kontrollera siffrorna.",
    });
    expect(parseOrgNumber("55990-1236").ok).toBe(false);
    expect(parseOrgNumber("55990A-1236").ok).toBe(false);
    expect(parseOrgNumber("99559900-1236").ok).toBe(false);
    expect(parseOrgNumber("")).toEqual({ ok: false, message: "Ange organisationsnumret." });
  });

  it("kontrollsiffran räknas med Luhn", () => {
    expect(luhnValid("5599001236")).toBe(true);
    expect(luhnValid("5599001235")).toBe(false);
    expect(luhnValid("abc")).toBe(false);
  });
});

describe("momsregistreringsnummer", () => {
  it("förslaget ur organisationsnumret är SE + tio siffror + 01", () => {
    expect(vatFromOrgNumber("559900-1236")).toBe("SE559900123601");
    expect(vatFromOrgNumber("fel")).toBeNull();
  });

  it("valfritt; mellanslag tas bort och se blir SE", () => {
    expect(parseVatNumber("")).toEqual({ ok: true, value: null });
    expect(parseVatNumber("se 559900-1236 01")).toEqual({ ok: true, value: "SE559900123601" });
  });

  it("annat format eller fel kontrollsiffra nekas", () => {
    expect(parseVatNumber("SE559900123602").ok).toBe(false);
    expect(parseVatNumber("559900123601").ok).toBe(false);
    expect(parseVatNumber("SE559900123701").ok).toBe(false);
  });
});

describe("bankgiro och postnummer", () => {
  it("bankgiro med sju eller åtta siffror och rätt kontrollsiffra", () => {
    expect(parseBankgiro("1234566")).toEqual({ ok: true, value: "123-4566" });
    expect(parseBankgiro("5050-1055")).toEqual({ ok: true, value: "5050-1055" });
    expect(parseBankgiro("")).toEqual({ ok: true, value: null });
    expect(parseBankgiro("123-4567").ok).toBe(false);
    expect(parseBankgiro("12-345").ok).toBe(false);
  });

  it("postnummer blir NNN NN", () => {
    expect(parsePostalCode("44130")).toEqual({ ok: true, value: "441 30" });
    expect(parsePostalCode("441 30")).toEqual({ ok: true, value: "441 30" });
    expect(parsePostalCode("")).toEqual({ ok: true, value: null });
    expect(parsePostalCode("4413").ok).toBe(false);
  });
});
