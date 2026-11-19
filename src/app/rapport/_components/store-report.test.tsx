/**
 * Butiksrapporten får ALDRIG visa inköpskostnad, marginal, vinst eller andra butikers
 * siffror. Testet bygger en ögonblicksbild där en annan butik och inköpspriser finns i
 * underlaget, renderar PDF-sidan (samma komponent som /rapport/[id] skriver ut) och
 * mejlet (mallen i src/emails) och söker efter sådana värden i HTML och text.
 *
 * Standard är den korta rapporten: uträkningen och summor, inga titlar, inget snittköp och
 * ingen service. Med butikens val "Visa detaljer i rapporten" visas de som förut. Båda
 * kontrolleras här, i PDF-sidan och i mejlet.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { renderReportEmail } from "@/emails/report-email";
import { vmbStatement, withoutVmbStatement, type StoreBasis } from "@/reports";
import { agreement, ord, placement, price, sources } from "@/reports/testing/fixtures";
import { reportEmailProps } from "@/server/reports/email";
import { cleanEmailHtml, cleanEmailText } from "@/server/reports/email-cleanup";
import { buildSnapshot, withStoreDetails, type StoreSnapshot } from "@/server/reports/snapshot";

import { StoreReportDocument } from "./store-report";

const ORG = { id: "org", name: "Binderlab AB", orgNumber: null, timeZone: "Europe/Stockholm" };

/** Underlaget för butikens bokföring med allt ifyllt. */
const BASIS: StoreBasis = {
  payer: {
    name: "Binderlab Sverige AB",
    legal: true,
    orgNumber: "559000-1234",
    address: "Storgatan 1, 111 22 Stockholm",
    vatNumber: "SE559000123401",
  },
  contract: { title: "Placeringsavtal", validFrom: "2026-11-03", signedOn: "2026-11-09" },
  vatMode: "added",
  vatRateBp: 2500,
};

function snapshot(details = false, basis: StoreBasis | null = null): StoreSnapshot {
  const src = sources({
    placements: [
      placement("m-1", "s-1", "2025-01-01", null),
      placement("m-2", "s-2", "2025-01-01", null),
    ],
    orders: [
      ord("2026-09-12", { amountOre: 4900 }),
      ord("2026-10-03", { amountOre: 4900 }),
      ord("2026-10-04", { amountOre: 5900, titleId: "t-b" }),
      ord("2026-10-09", { amountOre: 4900, titleId: "t-c" }),
      // Andra butikens försäljning: 777 kr, ska aldrig synas.
      ord("2026-10-10", { amountOre: 77_700, machineId: "m-2" }),
    ],
    // Inköpspris 13,37 kr: ett belopp som inte kan uppstå på annat sätt.
    prices: [price("t-a", 1337, "2026-01-01"), price("t-b", 1337, "2026-01-01")],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1200, monthlyRentOre: 50_000 }),
      agreement("s-2", "2026-01-01", null, { monthlyRentOre: 99_900 }),
    ],
  });
  const snap = buildSnapshot({
    type: "butik",
    month: "2026-10",
    organization: ORG,
    sources: src,
    generatedAt: "2026-11-01T05:00:00.000Z",
    storeId: "s-1",
    greeting: "Tack för ett bra samarbete!",
    storeDetails: details,
    storeBasis: basis,
    storeService: {
      refills: { count: 3, last: "2026-10-27" },
      busiest: "Lördagar 12–15",
      busiestOrders: 25,
    },
  });
  if (snap.type !== "butik") throw new Error("fel typ");
  return snap;
}

/** Ord och belopp som aldrig får finnas i något som når butiken. */
const FORBIDDEN = [
  /inköp/i,
  /marginal/i,
  /vinst/i,
  /förlust/i,
  /lönsam/i,
  /Mobilia/,
  /Väla/,
  /13,37/,
  /777/,
  /999/,
];

/** Ark i den korta rapporten. */
const PAGES_SHORT = 1;

function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#xA0;/g, " ")
    .replace(/\s+/g, " ");
}

/** Det som bara finns med "Visa detaljer i rapporten": titlar, snittköp och service. */
const DETAILS_ONLY = [
  /30th Celebration/,
  /Prismatic Evolutions/,
  /Titlar/,
  /Övriga titlar/,
  /Snittköp/,
  /Flest köp/,
  /Lördagar 12/,
  /[Pp]åfyllning/,
  /Service/,
];

function emailFor(snap: StoreSnapshot) {
  const email = renderReportEmail(
    reportEmailProps(snap, {
      recipientName: "Maria",
      reportUrl: "https://app.test/rapport/x",
      followText: null,
      reportId: "R-TEST01",
      attachments: [{ name: "binderlab-butik-nordstan-2026-10.pdf", size: 120_000 }],
      contact: { name: "Kim", phone: "070-000 00 00" },
    }),
  );
  // Som mejlet skickas: rader utan underlag är borttagna (email-cleanup).
  return {
    ...email,
    html: visibleText(cleanEmailHtml(email.html, "butik")),
    text: cleanEmailText(email.text, "butik"),
  };
}

describe("den korta rapporten (standard)", () => {
  const snap = snapshot();
  const text = visibleText(renderToStaticMarkup(<StoreReportDocument snapshot={snap} />));
  const plain = text.replace(/\u00a0|\u202f/g, " ");

  it("rubriken säger beloppet", () => {
    expect(snap.report.details).toBe(false);
    expect(plain).toContain("Er ersättning för oktober: 518,84 kr.");
  });

  it("visar summorna, uträkningen, veckorna, automaterna och raden om underlag", () => {
    for (const word of [
      "Försäljning",
      "Sålda pack",
      "Er ersättning",
      "Så räknas ersättningen.",
      "Provision",
      "Hyra",
      "Försäljning per vecka.",
      "1 automat i butiken.",
      // Automaten: dagar i butiken, pack och försäljning på en rad.
      "I butiken 31 av 31 dagar · 3 pack · sålt för 157 kr",
      "Underlag per titel finns på begäran.",
    ])
      expect(plain, word).toContain(word);
    // Bredvid automaterna står veckorna utan "Mest i vecka …" (staplarna har beloppen).
    expect(plain).not.toContain("Mest i vecka");
  });

  it("visar inga titlar, inget snittköp och ingen service", () => {
    for (const re of DETAILS_ONLY) expect(plain, String(re)).not.toMatch(re);
  });

  it("är ett ark (att den får plats på en A4 kontrolleras i webbläsaren, e2e 05)", () => {
    const html = renderToStaticMarkup(<StoreReportDocument snapshot={snap} />);
    expect(html.match(/data-page=/g)?.length ?? 0).toBe(PAGES_SHORT);
  });

  it("mejlet: beloppet i rubriken, summor per automat, ingen service och inga titlar", () => {
    const email = emailFor(snap);
    for (const body of [email.html, email.text]) {
      const b = body.replace(/\u00a0|\u202f/g, " ");
      expect(b).toContain("Er ersättning för oktober: 518,84 kr.");
      expect(b).toContain("Kim");
      for (const re of DETAILS_ONLY) expect(b, String(re)).not.toMatch(re);
    }
  });
});

describe("med Visa detaljer i rapporten", () => {
  const snap = snapshot(true);
  const html = renderToStaticMarkup(<StoreReportDocument snapshot={snap} />);
  const plain = visibleText(html).replace(/\u00a0|\u202f/g, " ");

  it("visar titlarna och service som förut, och ingen rad om underlag på begäran", () => {
    expect(snap.report.details).toBe(true);
    for (const word of [
      "30th Celebration",
      "Titlar",
      "Snittköp",
      "3 påfyllningsbesök.",
      "Flest köp",
      "Lördagar 12–15",
      "Er ersättning för oktober: 518,84 kr.",
    ])
      expect(plain, word).toContain(word);
    expect(plain).not.toContain("Underlag per titel finns på begäran.");
    expect(html.match(/data-page=/g)?.length ?? 0).toBe(PAGES_SHORT + 1);
  });

  it("mejlet visar service", () => {
    const email = emailFor(snap);
    for (const body of [email.html, email.text]) {
      expect(body).toContain("Flest köp");
      expect(body).toContain("Påfyllningar");
    }
  });

  it("läcker ändå inget förbjudet", () => {
    for (const re of FORBIDDEN) expect(plain, String(re)).not.toMatch(re);
  });
});

describe("rapporter från före valet fanns", () => {
  /** En äldre ögonblicksbild: titlarna finns i underlaget men valet är inte sparat. */
  function legacy(): StoreSnapshot {
    const full = snapshot(true);
    const { details: _details, ...report } = full.report;
    void _details;
    return { ...full, report };
  }

  it("en godkänd eller skickad rapport visas som den skickades, med detaljer", () => {
    const snap = withStoreDetails(legacy(), true);
    const plain = visibleText(renderToStaticMarkup(<StoreReportDocument snapshot={snap} />));
    expect(plain).toContain("30th Celebration");
    expect(plain).toContain("Flest köp");
  });

  it("ett utkast visas enligt den nya standarden, utan detaljer", () => {
    const snap = withStoreDetails(legacy(), false);
    const plain = visibleText(renderToStaticMarkup(<StoreReportDocument snapshot={snap} />));
    for (const re of DETAILS_ONLY) expect(plain, String(re)).not.toMatch(re);
    expect(plain).toContain("Underlag per titel finns på begäran.");
  });

  it("utan regeln (valet okänt) visas aldrig mer än den korta rapporten", () => {
    const plain = visibleText(renderToStaticMarkup(<StoreReportDocument snapshot={legacy()} />));
    for (const re of DETAILS_ONLY) expect(plain, String(re)).not.toMatch(re);
  });
});

describe("underlag för butikens bokföring", () => {
  const snap = snapshot(false, BASIS);
  const html = renderToStaticMarkup(<StoreReportDocument snapshot={snap} />);
  const plain = visibleText(html).replace(/\u00a0|\u202f/g, " ");

  it("visar vilket bolag som betalar, mottagaren och avtalet", () => {
    expect(snap.report.basis).toEqual(BASIS);
    for (const text of [
      "Ersättningen betalas av",
      "Binderlab Sverige AB",
      "Org.nr 559000-1234",
      "Momsreg.nr SE559000123401",
      "Storgatan 1, 111 22 Stockholm",
      "Mottagare",
      "Enligt Placeringsavtal från 3 november 2026, undertecknat 9 november 2026.",
    ])
      expect(plain, text).toContain(text);
    // Avsändaren i sidhuvudet är bolaget som betalar.
    expect(plain).toContain("från Binderlab Sverige AB");
  });

  it("visar ersättningen, momsen och beloppet att fakturera", () => {
    // 518,84 kr + 25 % moms (129,71 kr) = 648,55 kr.
    for (const text of [
      "Att fakturera",
      "Ersättning exkl. moms",
      "518,84 kr",
      "Moms 25 %",
      "129,71 kr",
      "648,55 kr",
      "Ersättningen är exklusive moms. Ni fakturerar Binderlab Sverige AB och lägger på svensk moms, 25 %.",
      "Binderlab Sverige AB är säljare av varorna i automaten.",
    ])
      expect(plain, text).toContain(text);
  });

  it("är fortfarande ett ark och läcker inget", () => {
    expect(html.match(/data-page=/g)?.length ?? 0).toBe(PAGES_SHORT);
    for (const re of FORBIDDEN) expect(plain, String(re)).not.toMatch(re);
  });

  it("samma block i rapporten med detaljer", () => {
    const full = visibleText(
      renderToStaticMarkup(<StoreReportDocument snapshot={snapshot(true, BASIS)} />),
    ).replace(/\u00a0|\u202f/g, " ");
    expect(full).toContain("Ersättningen betalas av");
    expect(full).toContain("648,55 kr");
  });

  it("Visa ingen momsrad: inga momsbelopp och ingen mening om moms", () => {
    const none = visibleText(
      renderToStaticMarkup(
        <StoreReportDocument snapshot={snapshot(false, { ...BASIS, vatMode: "none" })} />,
      ),
    ).replace(/\u00a0|\u202f/g, " ");
    expect(none).toContain("Ersättningen betalas av");
    expect(none).toContain("Binderlab Sverige AB är säljare av varorna i automaten.");
    for (const text of ["Att fakturera", "Moms 25 %", "648,55", "redovisar momsen", "svensk moms"])
      expect(none, text).not.toContain(text);
  });

  it("utan undertecknat avtal står ingen avtalsrad", () => {
    const bare = visibleText(
      renderToStaticMarkup(
        <StoreReportDocument snapshot={snapshot(false, { ...BASIS, contract: null })} />,
      ),
    );
    expect(bare).toContain("Ersättningen betalas av");
    expect(bare).not.toContain("Enligt ");
    expect(bare).not.toContain("undertecknat");
  });

  it("en rapport från före uppgifterna fanns visas som förut, utan blocket", () => {
    const old = snapshot();
    expect(old.report.basis).toBeUndefined();
    const text = visibleText(renderToStaticMarkup(<StoreReportDocument snapshot={old} />));
    for (const word of ["Ersättningen betalas av", "Att fakturera", "Org.nr", "Momsreg.nr"])
      expect(text, word).not.toContain(word);
    expect(text).toContain("från Binderlab AB");
    const email = emailFor(old);
    expect(email.html).not.toMatch(/underlag för bokföringen/i);
    expect(email.text).not.toMatch(/underlag för bokföringen/i);
  });

  it("mejlet (HTML och text) har samma uppgifter som PDF:en", () => {
    const email = emailFor(snap);
    for (const body of [email.html, email.text]) {
      const b = body.replace(/\u00a0|\u202f/g, " ");
      // Rubriken står med versaler i textdelen.
      expect(b).toMatch(/underlag för bokföringen/i);
      for (const text of [
        "Binderlab Sverige AB",
        "Org.nr 559000-1234",
        "Storgatan 1, 111 22 Stockholm",
        "Momsreg.nr SE559000123401",
        "Mottagare",
        "Nordstan",
        "Ersättning exkl. moms",
        "518,84 kr",
        "Moms 25 %",
        "129,71 kr",
        "Att fakturera",
        "648,55 kr",
        "Enligt Placeringsavtal från 3 november 2026, undertecknat 9 november 2026.",
        "Ersättningen är exklusive moms. Ni fakturerar Binderlab Sverige AB och lägger på svensk moms, 25 %.",
        "Binderlab Sverige AB är säljare av varorna i automaten.",
      ])
        expect(b, text).toContain(text);
      for (const re of FORBIDDEN) expect(b, String(re)).not.toMatch(re);
    }
  });
});

describe("Vi säljer med vinstmarginalbeskattning (VMB)", () => {
  const vmb: StoreBasis = { ...BASIS, vmb: true };
  const snap = snapshot(false, vmb);
  const html = renderToStaticMarkup(<StoreReportDocument snapshot={snap} />);
  const plain = visibleText(html).replace(/\u00a0|\u202f/g, " ");
  const STATEMENT = vmbStatement("Binderlab Sverige AB");

  it("rapporten säger det, på ett ark", () => {
    expect(STATEMENT).toBe(
      "Binderlab Sverige AB är säljare av varorna i automaten och redovisar momsen på den försäljningen enligt reglerna om vinstmarginalbeskattning (VMB). Den momsen berör inte butiken. Butikens ersättning är betalning för en tjänst och omfattas inte av VMB.",
    );
    expect(plain).toContain(STATEMENT);
    expect(html.match(/data-page=/g)?.length ?? 0).toBe(PAGES_SHORT);
  });

  it("skatteregelns namn står bara i den fasta texten: resten är lika strängt som förut", () => {
    // Hela texten har ordet, men bara i den fasta texten.
    expect(plain).toMatch(/vinstmarginalbeskattning/);
    const rest = withoutVmbStatement(plain, vmb);
    for (const re of FORBIDDEN) expect(rest, String(re)).not.toMatch(re);
    const email = emailFor(snap);
    for (const body of [email.html, email.text]) {
      const b = body.replace(/\u00a0|\u202f/g, " ");
      expect(b).toContain(STATEMENT);
      for (const re of FORBIDDEN) expect(withoutVmbStatement(b, vmb), String(re)).not.toMatch(re);
    }
  });

  it("av: ordet står ingenstans, och inget undantag görs", () => {
    const off = snapshot(false, { ...BASIS, vmb: false });
    const text = visibleText(renderToStaticMarkup(<StoreReportDocument snapshot={off} />));
    expect(text).toContain("Binderlab Sverige AB är säljare av varorna i automaten.");
    for (const re of FORBIDDEN) expect(text, String(re)).not.toMatch(re);
    const email = emailFor(off);
    for (const body of [email.html, email.text])
      for (const re of FORBIDDEN) expect(body, String(re)).not.toMatch(re);
  });
});

describe("butiksrapporten läcker inget", () => {
  const snap = snapshot();

  it("räknar rätt underlag", () => {
    expect(snap.report.sales.revenueOre).toBe(4900 + 5900 + 4900);
    expect(snap.report.compensation.totalOre).toBe(588 + 708 + 588 + 50_000);
  });

  it("PDF-sidan visar ersättningen men inga förbjudna värden", () => {
    const html = renderToStaticMarkup(<StoreReportDocument snapshot={snap} />);
    const text = visibleText(html);
    expect(text).toContain("Nordstan");
    expect(text).toContain("Tack för ett bra samarbete!");
    expect(text).toContain("Er ersättning");
    for (const re of FORBIDDEN) expect(text, String(re)).not.toMatch(re);
  });

  it("mejlet (HTML och text) visar inga förbjudna värden", () => {
    const email = renderReportEmail(
      reportEmailProps(snap, {
        recipientName: "Maria",
        reportUrl: "https://app.test/rapport/x",
        followText: null,
        reportId: "R-TEST01",
        attachments: [{ name: "binderlab-butik-nordstan-2026-10.pdf", size: 120_000 }],
      }),
    );
    expect(email.text).toContain("Hej Maria,");
    expect(email.text).toContain("Nordstan");
    for (const body of [visibleText(email.html), email.text, email.subject, email.preheader]) {
      for (const re of FORBIDDEN) expect(body, String(re)).not.toMatch(re);
    }
  });
});

describe("butiksrapporten med vinstdelning", () => {
  const src = sources({
    placements: [
      placement("m-1", "s-1", "2025-01-01", null),
      placement("m-2", "s-2", "2025-01-01", null),
    ],
    orders: [
      ord("2026-10-03", { amountOre: 19_900 }),
      ord("2026-10-04", { amountOre: 19_900 }),
      ord("2026-10-10", { amountOre: 77_700, machineId: "m-2" }),
    ],
    prices: [price("t-a", 13_000, "2026-01-01")],
    agreements: [
      {
        ...agreement("s-1", "2026-10-01", null, { commissionBp: 5_000 }),
        commissionBase: "profit_after_costs",
        vmbBeforeSplit: true,
      },
      agreement("s-2", "2026-01-01", null, { monthlyRentOre: 99_900 }),
    ],
  });
  const snap = buildSnapshot({
    type: "butik",
    month: "2026-10",
    organization: ORG,
    sources: src,
    generatedAt: "2026-11-01T05:00:00.000Z",
    storeId: "s-1",
  });

  it("visar avtalet och tabellen Försäljning → Er andel, men inget om andra butiker", () => {
    if (snap.type !== "butik") throw new Error("fel typ");
    // 398 kr sålt, 260 kr inköp: VMB 27,60 kr, vinst 110,40 kr, butiken 55,20 kr.
    expect(snap.report.compensation.totalOre).toBe(5_520);
    const text = visibleText(renderToStaticMarkup(<StoreReportDocument snapshot={snap} />));
    expect(text).toContain(
      "Avtal: 50 % av vinsten efter kostnader (VMB-moms dras före delning), giltigt från 1 oktober 2026.",
    );
    for (const label of [
      "Försäljning",
      "VMB-moms",
      "Inköp",
      "Kortavgifter",
      "Vinst",
      "Er andel 50 %",
    ])
      expect(text).toContain(label);
    // Bara vinstdelning: ingen totalrad med samma tal en gång till.
    expect(text).not.toContain("Andel 55,20 kr");
    expect(text).toContain("110,40");
    for (const re of [/Mobilia/, /777/, /999/]) expect(text, String(re)).not.toMatch(re);
  });
});
