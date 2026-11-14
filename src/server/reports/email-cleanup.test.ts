/**
 * Mejlen innehåller inga rader med "–" för fält som saknar underlag (andel i drift,
 * avbrott, nästa besök, postadress, kassaflöde), varken i HTML- eller textdelen, och
 * sektionerna numreras om. Kontorader i bokföringsunderlaget lämnas orörda.
 */

import { describe, expect, it } from "vitest";

import { renderReportEmail } from "@/emails/report-email";
import { agreement, ord, placement, price, sources } from "@/reports/testing/fixtures";

import { reportEmailProps } from "./email";
import { cleanEmailHtml, cleanEmailText, hasMissing } from "./email-cleanup";
import { buildSnapshot, type ReportSnapshot } from "./snapshot";

const ORG = { id: "org", name: "Binderlab AB", orgNumber: null, timeZone: "Europe/Stockholm" };
const SENDER = { name: "Binderlab AB", address: "–", email: "rapporter@binderlab.se" };

function snap(
  type: "butik" | "bokforing" | "delagare",
  refills = 2,
  /** Butikens val "Visa detaljer i rapporten" (service i mejlet). */
  details = true,
): ReportSnapshot {
  const src = sources({
    placements: [placement("m-1", "s-1", "2025-01-01", null)],
    orders: [ord("2026-10-03", { amountOre: 4900 }), ord("2026-10-05", { amountOre: 4900 })],
    prices: [price("t-a", 1337, "2026-01-01")],
    agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1200 })],
  });
  return buildSnapshot({
    type,
    month: "2026-10",
    organization: ORG,
    sources: src,
    generatedAt: "2026-11-01T05:00:00.000Z",
    storeId: "s-1",
    storeDetails: details,
    storeService: {
      refills: { count: refills, last: refills > 0 ? "2026-10-20" : null },
      busiest: null,
      busiestOrders: 2,
    },
  });
}

function render(s: ReportSnapshot) {
  return renderReportEmail(
    reportEmailProps(s, {
      recipientName: "Maria",
      reportUrl: "https://app.test/rapport/x",
      followText: null,
      reportId: "R-1",
      attachments: [],
      sender: SENDER,
    }),
  );
}

function visible(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#xA0;/g, " ")
    .replace(/\s+/g, " ");
}

function sectionNumbers(text: string): string[] {
  return [...text.matchAll(/(\d{2}) \/ /g)].map((m) => m[1]!);
}

describe("hasMissing", () => {
  it("känner igen ett fristående streck men inte ett intervall", () => {
    expect(hasMissing("– av öppettiden")).toBe(true);
    expect(hasMissing("Binderlab, –")).toBe(true);
    expect(hasMissing("Lördagar 12–15")).toBe(false);
    expect(hasMissing("49 kr")).toBe(false);
  });
});

describe("butiksmejlet", () => {
  const s = snap("butik");
  const email = render(s);
  const html = visible(cleanEmailHtml(email.html, "butik"));
  const text = cleanEmailText(email.text, "butik");

  it("rådata innehåller de saknade fälten (annars testar vi inget)", () => {
    expect(visible(email.html)).toContain("Nästa besök");
    expect(email.text).toContain("Nästa besök");
  });

  it("tar bort rader och kolumner utan underlag i HTML och text", () => {
    for (const body of [html, text]) {
      for (const word of ["I drift", "i drift", "Avbrott", "Nästa besök", "Kontakt", "Flest köp"]) {
        expect(body, word).not.toContain(word);
      }
      expect(body).not.toMatch(/(^|[\s,(])–(?=$|[\s,.)])/m);
      expect(body).toContain("Påfyllningar");
      expect(body).toContain("Binderlab AB · rapporter@binderlab.se");
    }
  });

  it("har kort ämnesrad och avregistrering utan inloggning", () => {
    expect(email.subject).toBe("Butiksrapport oktober 2026 · Nordstan");
    expect(text).toMatch(/Avregistrera: mailto:rapporter@binderlab\.se\?subject=/);
    expect(text).not.toContain("/installningar/utskick");
  });

  it("numrerar sektionerna i ordning", () => {
    for (const body of [html, text]) {
      const nums = sectionNumbers(body);
      expect(nums).toEqual(nums.map((_, i) => String(i + 1).padStart(2, "0")));
    }
  });

  it("utan Visa detaljer (standard): ingen service i mejlet, och beloppet står i rubriken", () => {
    const short = render(snap("butik", 2, false));
    const shortHtml = visible(cleanEmailHtml(short.html, "butik"));
    const shortText = cleanEmailText(short.text, "butik");
    for (const body of [shortHtml, shortText]) {
      for (const word of ["Påfyllningar", "Flest köp", "Drift och service", "DRIFT OCH SERVICE"]) {
        expect(body, word).not.toContain(word);
      }
      expect(body.replace(/\u00a0/g, " ")).toContain("Er ersättning för oktober: 11,76 kr.");
      expect(body).not.toMatch(/(^|[\s,(])–(?=$|[\s,.)])/m);
    }
  });

  it("utan påfyllningar försvinner hela sektionen Drift och service", () => {
    const e = render(snap("butik", 0));
    const h = visible(cleanEmailHtml(e.html, "butik"));
    const t = cleanEmailText(e.text, "butik");
    expect(h).not.toMatch(/Drift och service/i);
    expect(t).not.toMatch(/DRIFT OCH SERVICE/);
  });
});

describe("delägarmejlet", () => {
  const email = render(snap("delagare"));
  const html = visible(cleanEmailHtml(email.html, "delagare"));
  const text = cleanEmailText(email.text, "delagare");

  it("tar bort kassaflödet, som saknar underlag", () => {
    expect(visible(email.html)).toContain("Kassaflöde");
    expect(html).not.toContain("Kassaflöde");
    expect(text).not.toContain("KASSAFLÖDE");
    expect(html).toContain("Vinst");
    for (const body of [html, text]) {
      const nums = sectionNumbers(body);
      expect(nums).toEqual(nums.map((_, i) => String(i + 1).padStart(2, "0")));
    }
  });
});

describe("bokföringsmejlet", () => {
  it("lämnar kontoraderna orörda och städar bara sidfoten", () => {
    const email = render(snap("bokforing"));
    const html = cleanEmailHtml(email.html, "bokforing");
    expect(html.length).toBe(email.html.length - " – ·".length);
    expect(cleanEmailText(email.text, "bokforing")).toContain(
      "Binderlab AB · rapporter@binderlab.se",
    );
  });
});
