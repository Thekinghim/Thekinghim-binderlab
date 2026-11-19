/**
 * Butiksportalens rapportsida: underlaget för butikens bokföring visas som i PDF:en, och
 * inte alls för en rapport från före uppgifterna fanns.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildStoreReport, type StoreBasis, type StoreReport } from "@/reports";
import { octoberExample } from "@/reports/testing/fixtures";

import { BasisSection } from "./sections";

const BASIS: StoreBasis = {
  payer: {
    name: "Binderlab AB",
    legal: true,
    orgNumber: "559000-1234",
    address: "Storgatan 1, 111 22 Stockholm",
    vatNumber: "SE559000123401",
  },
  contract: { title: "Placeringsavtal", validFrom: "2026-11-03", signedOn: "2026-11-09" },
  vatMode: "added",
  vatRateBp: 2500,
};

const report = buildStoreReport(octoberExample(), "s-1", "2026-10");
const text = (r: StoreReport) =>
  renderToStaticMarkup(<BasisSection report={r} />)
    .replace(/<[^>]+>/g, " ")
    .replace(/ |&nbsp;/g, " ")
    .replace(/\s+/g, " ");

describe("butiksportalen: underlag för bokföringen", () => {
  it("visar bolaget som betalar, mottagaren, beloppen att fakturera och avtalet", () => {
    const out = text({ ...report, basis: BASIS });
    for (const part of [
      "Underlag för bokföringen",
      "Ersättningen betalas av",
      "Binderlab AB",
      "Org.nr 559000-1234",
      "Storgatan 1, 111 22 Stockholm",
      "Momsreg.nr SE559000123401",
      "Mottagare",
      report.store.name,
      "Er faktura",
      "Ersättning exkl. moms",
      "Moms 25 %",
      "Att fakturera",
      "Enligt Placeringsavtal från 3 november 2026, undertecknat 9 november 2026.",
      "Ni fakturerar Binderlab AB och lägger på svensk moms, 25 %.",
    ])
      expect(out, part).toContain(part);
  });

  it("Visa ingen momsrad: inga belopp att fakturera", () => {
    const out = text({ ...report, basis: { ...BASIS, vatMode: "none" } });
    expect(out).toContain("Ersättningen betalas av");
    expect(out).not.toContain("Er faktura");
    expect(out).not.toContain("Moms 25 %");
  });

  it("muntligt avtal: raden med villkoren, och försäljningens mening", () => {
    const out = text({
      ...report,
      basis: { ...BASIS, rev: 2, agreementForm: "oral", contract: null, vmb: true },
    });
    expect(out).toContain(`Muntligt avtal mellan Binderlab AB och ${report.store.name}: `);
    expect(out).not.toContain("Enligt Placeringsavtal");
    expect(out).toContain("enligt reglerna om vinstmarginalbeskattning (VMB)");
    expect(out).toContain(
      `Försäljningen är kundernas köp i automater som stod i ${report.store.name} köpdagen`,
    );
  });

  it("en rapport utan uppgifterna visar ingenting", () => {
    expect(renderToStaticMarkup(<BasisSection report={report} />)).toBe("");
  });
});
