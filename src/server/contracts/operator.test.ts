import { describe, expect, it } from "vitest";

import { contractHtml } from "@/reports/contract-pdf";

import { EMPTY_COMPANY, operatorGaps, operatorParty } from "./operator";

describe("operatorParty", () => {
  it("fyller i våra företagsuppgifter i kontraktet (tidigare bara namn och org.nr)", () => {
    const party = operatorParty("Binderlab", {
      companyName: "Binderlab AB",
      orgNumber: "559000-1234",
      companyAddress: "Storgatan 1, 111 22 Stockholm",
      contactName: "Wille",
      contactEmail: "hej@binderlab.se",
      contactPhone: "070-123 45 67",
    });
    expect(party).toEqual({
      name: "Binderlab AB",
      orgNumber: "559000-1234",
      address: "Storgatan 1, 111 22 Stockholm",
      contactName: "Wille",
      email: "hej@binderlab.se",
      phone: "070-123 45 67",
    });
    expect(operatorGaps(party)).toEqual([]);
    const html = contractHtml({
      operator: party,
      store: { name: "Sega gubben" },
      validFrom: "2026-10-14",
      shareBp: 5_000,
      lossTreatment: "zero",
      monthlyRentOre: null,
      reference: "TEST",
    });
    const operatorBlock = html.slice(html.indexOf("Operatören"), html.indexOf("Butiken</div>"));
    expect(operatorBlock).toContain("Storgatan 1");
    expect(operatorBlock).toContain("hej@binderlab.se");
    expect(operatorBlock).toContain("070-123 45 67");
    expect(operatorBlock).not.toContain("_____");
  });

  it("utan uppgifter: organisationens namn och vilka rader som blir tomma", () => {
    const party = operatorParty("Binderlab", EMPTY_COMPANY);
    expect(party.name).toBe("Binderlab");
    expect(operatorGaps(party)).toEqual(["org.nr", "adress", "kontaktperson", "e-post", "telefon"]);
    expect(operatorParty("Binderlab", { ...EMPTY_COMPANY, companyName: "  " }).name).toBe(
      "Binderlab",
    );
  });
});

describe("contractHtml på mobilen", () => {
  it("har viewport, så att kontraktet inte visas 980 px brett på iPhone", () => {
    const html = contractHtml({
      operator: { name: "Binderlab" },
      store: { name: "Sega gubben" },
      validFrom: "2026-10-14",
      shareBp: 5_000,
      lossTreatment: "zero",
      monthlyRentOre: null,
      reference: "TEST",
    });
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
  });
});
