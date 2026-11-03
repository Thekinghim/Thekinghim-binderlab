import { describe, expect, it } from "vitest";

import {
  CONTRACT_TEMPLATE,
  contractHtml,
  contractSections,
  contractTermsPlain,
  contractTermsSummary,
  escapeHtml,
  shareText,
  specialTermsParagraphs,
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
      "försäljning inklusive moms − återbetalningar till kunder − inköpspris för sålda varor − kort- och betalningsavgifter",
    );
    expect(t).toContain("dras inte före delningen");
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

  it("utan VMB-avdrag som standard; avtal med VMB-avdrag säger det i texten och villkoren", () => {
    expect(text(INPUT)).not.toContain("− moms enligt vinstmarginalbeskattning");
    expect(text({ ...INPUT, vmbBeforeSplit: false })).toBe(text(INPUT));
    const t = text({ ...INPUT, vmbBeforeSplit: true });
    expect(t).toContain("− moms enligt vinstmarginalbeskattning (VMB)");
    expect(t).not.toContain("dras inte före delningen");
    expect(contractTermsSummary({ shareBp: 5_000, lossTreatment: "zero" })).toContain(
      "dras inte före delningen",
    );
    expect(
      contractTermsSummary({ shareBp: 5_000, lossTreatment: "zero", vmbBeforeSplit: true }),
    ).toContain("− moms enligt vinstmarginalbeskattning (VMB)");
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

  it("procent av omsättningen: ingen vinstdefinition, omsättningen definieras", () => {
    const t = text({ ...INPUT, shareBp: 1_250, base: "net_excl_vat" }).replace(/\s/g, " ");
    expect(t).toContain("Butiken får 12,5 % av automatens omsättning.");
    expect(t).toContain("Omsättning = automatens försäljning exklusive moms");
    expect(t).not.toContain("Vinst =");
    expect(t).not.toContain("förlust");
    expect(t).toContain("Butiken får en andel av försäljningen.");
  });

  it("fast hyra utan andel: bara hyran", () => {
    const t = text({ ...INPUT, shareBp: null, base: "net_excl_vat", monthlyRentOre: 150_000 });
    expect(t.replace(/\s/g, " ")).toContain(
      "Operatören betalar Butiken en fast hyra på 1 500 kr per månad (exklusive moms) för platsen.",
    );
    expect(t).not.toContain("av vinsten");
    expect(t).toContain("Rapporten visar hyran.");
  });

  it("särskilda villkor blir ett eget avsnitt före Övrigt, escapat i HTML", () => {
    const special = "Automaten står vid kassan.\n\n<b>El</b> ingår.";
    const sections = contractSections({ ...INPUT, specialTerms: special });
    expect(sections.map((x) => x.heading).slice(-2)).toEqual(["8. Särskilda villkor", "9. Övrigt"]);
    expect(sections.at(-2)!.paragraphs).toEqual(["Automaten står vid kassan.", "<b>El</b> ingår."]);
    const html = contractHtml({ ...INPUT, specialTerms: special });
    expect(html).toContain("&lt;b&gt;El&lt;/b&gt; ingår.");
    expect(html).not.toContain("<b>El</b>");
    expect(contractSections(INPUT).at(-1)!.heading).toBe("8. Övrigt");
    expect(specialTermsParagraphs("  \n ")).toEqual([]);
  });

  it("villkoren i klartext och andelen exakt", () => {
    const plain = (x: Parameters<typeof contractTermsPlain>[0]) =>
      contractTermsPlain(x).replace(/\s/g, " ");
    expect(plain(INPUT)).toBe("50 % av vinsten efter kostnader");
    expect(plain({ ...INPUT, shareBp: 1_000, base: "net_excl_vat" })).toBe(
      "10 % av omsättningen exkl. moms",
    );
    expect(plain({ ...INPUT, shareBp: null, monthlyRentOre: 150_000 })).toBe(
      "Fast hyra 1 500 kr/mån",
    );
    expect(plain({ ...INPUT, monthlyRentOre: 50_000, lossTreatment: "proportional" })).toBe(
      "50 % av vinsten efter kostnader + 500 kr/mån (delar förlust)",
    );
    expect(plain({ ...INPUT, shareBp: null, monthlyRentOre: null })).toBe("Inga villkor");
    expect(shareText(1_225).replace(/\s/g, " ")).toBe("12,25 %");
    expect(shareText(1_250).replace(/\s/g, " ")).toBe("12,5 %");
    expect(
      contractTermsSummary({ shareBp: 1_000, base: "net_excl_vat", lossTreatment: "zero" }),
    ).toContain("Andel av omsättningen");
  });
});
