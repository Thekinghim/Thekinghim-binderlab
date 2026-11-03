import { describe, expect, it } from "vitest";

import {
  CONTRACT_TEMPLATE,
  contractHtml,
  contractSections,
  contractTermsSummary,
  escapeHtml,
  type ContractTemplateInput,
} from "./contract-pdf";

const INPUT: ContractTemplateInput = {
  operator: { name: "Binderlab AB", orgNumber: "559000-0000" },
  store: { name: "Sega gubben", address: "Storgatan 1, Umeå", contactName: "Anna", email: null },
  validFrom: "2026-11-03",
  shareBp: 5_000,
  lossTreatment: "zero",
  monthlyRentOre: null,
  reference: "ABCD1234",
};

const text = (input: ContractTemplateInput) =>
  contractSections(input)
    .flatMap((s) => [s.heading, ...s.paragraphs])
    .join("\n");

describe("placeringsavtalet", () => {
  it("har vinstdelningen 50/50 med definitionen och förlust ger 0", () => {
    const t = text(INPUT);
    expect(t).toContain("Butiken får 50 % av vinsten");
    expect(t).toContain("Operatören behåller 50 %");
    expect(t).toContain(
      "försäljning inklusive moms − återbetalningar till kunder − moms enligt vinstmarginalbeskattning (VMB) − inköpspris för sålda varor − kort- och betalningsavgifter",
    );
    expect(t).toContain("får Butiken 0 kr");
    expect(t).not.toContain("hyra");
  });

  it("start, tills vidare, 1 månads uppsägning, utbetalning senast den 15:e", () => {
    const t = text(INPUT);
    expect(t).toContain("Avtalet gäller från 3 november 2026 tills vidare");
    expect(t).toContain("1 månads uppsägningstid");
    expect(t).toContain("senast den 15 i månaden efter");
  });

  it("proportionell förlust och hyra när avtalet har det", () => {
    const t = text({ ...INPUT, lossTreatment: "proportional", monthlyRentOre: 50_000 });
    expect(t).toContain("bär Butiken 50 % av förlusten");
    expect(t).toContain("fast hyra på 500 kr per månad");
  });

  it("HTML: parterna, tomma rader för det som saknas, och escapad text", () => {
    const html = contractHtml({ ...INPUT, store: { name: "<Sega & gubben>" } });
    expect(html).toContain("Binderlab AB");
    expect(html).toContain("559000-0000");
    expect(html).toContain("&lt;Sega &amp; gubben&gt;");
    expect(html).not.toContain("<Sega");
    expect(html).toContain("_______________________");
    expect(html).toContain("Underskrift");
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });

  it("sammanfattningen i villkoren och mallens namn", () => {
    expect(contractTermsSummary({ shareBp: 5_000, lossTreatment: "zero" })).toContain(
      "butiken får 50 % av vinsten efter kostnader",
    );
    expect(CONTRACT_TEMPLATE).toMatch(/^[a-z0-9-]{1,60}$/);
  });
});
