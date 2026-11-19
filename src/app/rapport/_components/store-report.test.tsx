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

import { StoreReportDocument, splitPeriodTable, splitRows } from "./store-report";

const ORG = { id: "org", name: "Binderlab AB", orgNumber: null, timeZone: "Europe/Stockholm" };

/** Underlaget för butikens bokföring med allt ifyllt. */
const BASIS: StoreBasis = {
  rev: 2,
  payer: {
    name: "Binderlab Sverige AB",
    legal: true,
    orgNumber: "559000-1234",
    address: "Storgatan 1, 111 22 Stockholm",
    vatNumber: "SE559000123401",
    ownsMachines: true,
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

describe("försäljningen och momsen säger inte emot varandra", () => {
  const render = (basis: StoreBasis | null) => {
    const snap = snapshot(false, basis);
    return {
      page: visibleText(renderToStaticMarkup(<StoreReportDocument snapshot={snap} />)).replace(
        /\u00a0|\u202f/g,
        " ",
      ),
      email: emailFor(snap),
    };
  };

  it("rapporten säger vad försäljningen är och aldrig att ingen moms tas ut", () => {
    const { page, email } = render(BASIS);
    expect(page).toContain("Moms 25 %");
    // Provision och hyra, momssats 0 %: det kunderna betalade, inget påstående om moms.
    expect(page).toContain(
      "Försäljningen är kundernas köp i automater som stod i Nordstan köpdagen. Förra månaden",
    );
    for (const body of [page, email.html, email.text]) {
      expect(body).not.toMatch(/ingen moms/i);
      expect(body).not.toMatch(/tas ut/i);
      expect(body).not.toContain("exklusive moms (");
    }
    expect(email.html).toContain("Moms 25 %");
  });

  it("en rapport från före ändringen står som den skrevs", () => {
    const { rev: _rev, ...old } = BASIS;
    void _rev;
    for (const basis of [old, null]) {
      const { page, email } = render(basis);
      expect(page).toContain("köpdagen, exklusive moms (ingen moms tas ut).");
      expect(email.html).toContain("Ingen moms");
    }
  });
});

describe("juridiskt namn och namnet verksamheten kallas", () => {
  const BRAND: StoreBasis = {
    ...BASIS,
    payer: { ...BASIS.payer, name: "Kortautomater i Norden AB", brand: "Binderlab" },
  };
  const snap = snapshot(false, BRAND);
  const html = renderToStaticMarkup(<StoreReportDocument snapshot={snap} />);
  const page = visibleText(html).replace(/\u00a0|\u202f/g, " ");

  it("betalaren är det juridiska namnet, med verksamhetens namn en gång och vem som äger automaten", () => {
    expect(page).toContain(
      "Ersättningen betalas av Kortautomater i Norden AB (verksamheten kallas Binderlab) Äger och driver automaten. Org.nr 559000-1234",
    );
    expect(page.match(/verksamheten kallas/g)).toHaveLength(1);
    expect(page).toContain("Ni fakturerar Kortautomater i Norden AB och lägger på svensk moms");
    expect(html.match(/data-page=/g)?.length ?? 0).toBe(PAGES_SHORT);
  });

  it("mejlet har samma rader", () => {
    const email = emailFor(snap);
    for (const body of [email.html, email.text])
      expect(body).toContain("Kortautomater i Norden AB (verksamheten kallas Binderlab)");
    expect(email.html).toContain("Äger och driver automaten.");
    expect(email.text).toContain("som äger och driver automaten.");
  });

  it("samma namn: ingen parentes; en rapport från före ändringen: ingen rad om automaten", () => {
    const same = visibleText(
      renderToStaticMarkup(<StoreReportDocument snapshot={snapshot(false, BASIS)} />),
    );
    expect(same).not.toContain("verksamheten kallas");
    expect(same).toContain("Äger och driver automaten.");
    const { rev: _rev, ...old } = BASIS;
    void _rev;
    const before = visibleText(
      renderToStaticMarkup(<StoreReportDocument snapshot={snapshot(false, old)} />),
    );
    expect(before).not.toContain("Äger och driver");
    // Valet av i Inställningar: ingen rad om vem som äger automaten.
    const off = visibleText(
      renderToStaticMarkup(
        <StoreReportDocument
          snapshot={snapshot(false, { ...BASIS, payer: { ...BASIS.payer, ownsMachines: false } })}
        />,
      ),
    );
    expect(off).not.toContain("Äger och driver");
  });

  it("mejlet: sidhuvud, sidfot och raden om varför mejlet kommer säger det juridiska namnet", () => {
    const email = emailFor(snap);
    const text = email.text.replace(/\u00a0|\u202f/g, " ");
    expect(text).toContain(
      "i avtalet om automatplats med Kortautomater i Norden AB (verksamheten kallas Binderlab).",
    );
    expect(text).toContain("som ni får av Kortautomater i Norden AB.");
    expect(text).toContain("Kortautomater i Norden AB · Storgatan 1, 111 22 Stockholm ·");
    expect(text).not.toMatch(/^Binderlab ·/m);
    // Bolaget i löptext: inga trasiga skiljetecken.
    expect(text).toContain(
      "Ersättningen betalas av: Kortautomater i Norden AB (verksamheten kallas Binderlab), som äger och driver automaten. Org.nr 559000-1234",
    );
    expect(text).not.toContain("automaten.,");
  });
});

describe("redan betalt", () => {
  // 518,84 kr är betalt (ersättningen exklusive moms); kvar är momsen, 129,71 kr.
  const PAID: StoreBasis = { ...BASIS, payments: [{ paidOn: "2026-11-05", amountOre: 51_884 }] };
  const snap = snapshot(false, PAID);
  const html = renderToStaticMarkup(<StoreReportDocument snapshot={snap} />);

  it("fakturablocket visar Redan betalt och Kvar att betala, på sidan och i mejlet", () => {
    const email = emailFor(snap);
    for (const body of [visibleText(html), email.html, email.text]) {
      const b = body.replace(/\u00a0|\u202f/g, " ");
      for (const text of [
        "Att fakturera",
        "648,55 kr",
        "Redan betalt 5 nov. 2026",
        "518,84 kr",
        "Kvar att betala",
        "129,71 kr",
      ])
        expect(b, text).toContain(text);
    }
    expect(email.text.replace(/\u00a0|\u202f/g, " ")).toContain(
      "Redan betalt 5 nov. 2026: 518,84 kr",
    );
    expect(email.text.replace(/\u00a0|\u202f/g, " ")).toContain("Kvar att betala: 129,71 kr");
    expect(html.match(/data-page=/g)?.length ?? 0).toBe(PAGES_SHORT);
  });

  it("inget betalt: blocket som förut", () => {
    const text = visibleText(
      renderToStaticMarkup(<StoreReportDocument snapshot={snapshot(false, BASIS)} />),
    );
    expect(text).toContain("Att fakturera");
    expect(text).not.toContain("Redan betalt");
    expect(text).not.toContain("Kvar att betala");
  });
});

describe("avtalets form", () => {
  const ORAL =
    "Muntligt avtal mellan Binderlab Sverige AB och Nordstan: provision 12 % på kundernas betalning och hyra 500 kr per månad.";
  const render = (basis: StoreBasis) => {
    const snap = snapshot(false, basis);
    const email = emailFor(snap);
    return [
      visibleText(renderToStaticMarkup(<StoreReportDocument snapshot={snap} />)),
      email.html,
      email.text,
    ].map((b) => b.replace(/\u00a0|\u202f/g, " "));
  };

  it("muntligt avtal: samma rad på sidan och i mejlet, och inget skriftligt avtal påstås", () => {
    for (const body of render({ ...BASIS, agreementForm: "oral", contract: null })) {
      expect(body).toContain(ORAL);
      expect(body).not.toContain("Enligt Placeringsavtal");
      expect(body).not.toContain("undertecknat");
    }
  });

  it("skriftligt avtal: skriftligt, kontraktet, parterna och villkoren", () => {
    for (const body of render({ ...BASIS, agreementForm: "written" }))
      expect(body).toContain(
        "Skriftligt avtal (Placeringsavtal) mellan Binderlab Sverige AB och Nordstan från 3 november 2026, undertecknat 9 november 2026: provision 12 % på kundernas betalning och hyra 500 kr per månad.",
      );
  });

  it("inte valt och inget undertecknat kontrakt: rapporten säger att avtalet saknas", () => {
    for (const body of render({ ...BASIS, agreementForm: null, contract: null })) {
      expect(body).not.toContain("Muntligt avtal");
      expect(body).not.toContain("Enligt ");
      expect(body).toContain("Avtal saknas i underlaget.");
    }
  });
});

describe("raden som avslutar uträkningen", () => {
  const page = (basis: StoreBasis | null) =>
    visibleText(
      renderToStaticMarkup(<StoreReportDocument snapshot={snapshot(false, basis)} />),
    ).replace(/\u00a0|\u202f/g, " ");

  it("med momsrad: Er ersättning totalt, exklusive moms", () => {
    const text = page(BASIS);
    expect(text).toContain("Er ersättning totalt, exklusive moms");
    // Raden står sist i uträkningen, med delarna och beloppet.
    expect(text).toMatch(
      /Er ersättning totalt, exklusive moms\s+Provision 18,84 kr \+ hyra 500,00 kr = 518,84 kr\s+518,84 kr/,
    );
  });

  it("utan momsrad sägs ingenting om moms", () => {
    const text = page({ ...BASIS, vatMode: "none" });
    expect(text).toMatch(/Er ersättning totalt\s+Provision 18,84 kr/);
    expect(text).not.toContain("totalt, exklusive moms");
  });

  it("en rapport från före ändringen har rubriken som förut", () => {
    const { rev: _rev, ...old } = BASIS;
    void _rev;
    for (const basis of [old, null]) {
      const text = page(basis);
      expect(text).toContain("Ersättning totalt");
      expect(text).not.toContain("Er ersättning totalt");
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

describe("eget datum över två månader med vinstdelning (ägarens fall)", () => {
  const split = (validFrom: string, validTo: string | null, rent: number | null = null) => ({
    ...agreement("s-1", validFrom, validTo, { commissionBp: 5_000, monthlyRentOre: rent }),
    commissionBase: "profit_after_costs" as const,
    lossTreatment: "zero" as const,
  });
  function build(basis: StoreBasis | null, rent: number | null = null): StoreSnapshot {
    const snap = buildSnapshot({
      type: "butik",
      month: "2026-10",
      period: { start: "2026-10-14", end: "2026-11-14" },
      organization: ORG,
      sources: sources({
        orders: [
          ord("2026-10-20", { amountOre: 19_900 }),
          ord("2026-11-02", { amountOre: 19_900 }),
          ord("2026-11-10", { amountOre: 24_900 }),
        ],
        prices: [price("t-a", 13_000, "2026-01-01")],
        // Avtalet förnyades den 3 november med samma villkor.
        agreements: [split("2026-10-14", "2026-11-02", rent), split("2026-11-03", null, rent)],
      }),
      generatedAt: "2026-11-17T08:00:00.000Z",
      storeId: "s-1",
      storeBasis: basis,
    });
    if (snap.type !== "butik") throw new Error("fel typ");
    return snap;
  }
  const OWNER: StoreBasis = {
    ...BASIS,
    payer: { ...BASIS.payer, name: "Kortautomater i Norden AB", brand: "Binderlab" },
    agreementForm: "oral",
    contract: null,
    vmb: true,
    // Vinst 69 + 69 + 119 kr, hälften: 128,50 kr. Betalt exklusive moms.
    payments: [{ paidOn: "2026-11-16", amountOre: 12_850 }],
  };
  const page = (snap: StoreSnapshot) =>
    visibleText(renderToStaticMarkup(<StoreReportDocument snapshot={snap} />)).replace(
      /\u00a0|\u202f/g,
      " ",
    );

  it("oktober och november står bredvid varandra, med samma belopp som raderna", () => {
    const snap = build(OWNER);
    const c = snap.report.compensation;
    expect(c.totalOre).toBe(12_850);
    const table = splitPeriodTable(c)!;
    expect(table.periods.map((p) => p.label)).toEqual(["14–31 okt.", "1–14 nov."]);
    expect(table.rows.map((r) => [r.label.replace(/\u00a0/g, " "), ...r.amounts])).toEqual([
      ["Försäljning", 19_900, 44_800],
      ["Inköp", -13_000, -26_000],
      ["Kortavgifter", -0, -0],
      ["Vinst", 6_900, 18_800],
      ["Er andel 50 %", 3_450, 9_400],
    ]);
    // Samma belopp som i raderna under varandra (butiksportalen).
    const stacked = splitRows(c).map((r) => r.amountOre);
    expect(stacked).toEqual([
      19_900, -13_000, -0, 6_900, 3_450, 44_800, -26_000, -0, 18_800, 9_400,
    ]);
    expect(table.extras).toEqual([]);
  });

  it("hela rapporten: betalaren, det muntliga avtalet, VMB, totalraden och det som är betalt", () => {
    const text = page(build(OWNER));
    for (const part of [
      "Er ersättning för 14 okt.–14 nov. 2026: 128,50 kr exkl. moms.",
      "Post 14–31 okt. 1–14 nov.",
      "Er andel 50 % 34,50 kr 94,00 kr",
      "Er ersättning totalt, exklusive moms 128,50 kr",
      "Kortautomater i Norden AB (verksamheten kallas Binderlab) Äger och driver automaten.",
      "Muntligt avtal mellan Kortautomater i Norden AB och Nordstan: 50 % av vinsten efter kostnader.",
      vmbStatement("Kortautomater i Norden AB"),
      "Moms 25 % 32,13 kr",
      "Att fakturera 160,63 kr",
      "Redan betalt 16 nov. 2026 128,50 kr",
      "Kvar att betala 32,13 kr",
      "Underlag per titel finns på begäran. Försäljningen är kundernas köp i automater som stod i Nordstan köpdagen, inklusive moms.",
    ])
      expect(text, part).toContain(part);
    for (const gone of ["1–2 nov.", "3–14 nov.", "ingen moms tas ut", "Enligt ", "undertecknat"])
      expect(text, gone).not.toContain(gone);
  });

  it("mejlet: butiksrapport med perioden, uträkningen, totalraden och samma klocka som PDF:en", () => {
    const snap = build(OWNER);
    const email = emailFor(snap);
    for (const body of [email.html, email.text].map((b) => b.replace(/\u00a0|\u202f/g, " "))) {
      expect(body).toContain("Butiksrapport");
      expect(body).not.toContain("Månadsrapport");
      expect(body).not.toContain("månadens");
      expect(body).toContain("Här är försäljningen 14 okt.–14 nov. 2026 i Nordstan");
      expect(body).toContain("Er ersättning totalt, exklusive moms");
      expect(body).toContain("Er ersättning exkl. moms");
      expect(body).toContain("Vinst");
      // 17 nov. 08:00 UTC är 09:00 i Stockholm.
      expect(body).toContain("Skapad 17 nov. 2026 09:00");
    }
    // Organisationens tidszon gäller, inte serverns.
    const shanghai = emailFor({
      ...snap,
      organization: { ...snap.organization, timeZone: "Asia/Shanghai" },
    });
    expect(shanghai.text.replace(/\u00a0|\u202f/g, " ")).toContain("Skapad 17 nov. 2026 16:00");
  });

  it("förlust: inget att fakturera, och raden säger varför", () => {
    const loss = buildSnapshot({
      type: "butik",
      month: "2026-11",
      period: { start: "2026-11-01", end: "2026-11-18" },
      organization: ORG,
      sources: sources({
        orders: [ord("2026-11-10", { amountOre: 9_900 })],
        prices: [price("t-a", 13_000, "2026-01-01")],
        agreements: [split("2026-10-14", null)],
      }),
      generatedAt: "2026-11-19T08:00:00.000Z",
      storeId: "s-1",
      storeBasis: OWNER,
    });
    if (loss.type !== "butik") throw new Error("fel typ");
    expect(loss.report.compensation.totalOre).toBe(0);
    const text = page(loss);
    expect(text).toContain(
      "Inget att fakturera för 1–18 nov. 2026 (ingen vinst, andelen blir 0 kr).",
    );
    expect(text).toContain("Er andel 50 % (ingen vinst, 0 kr)");
    const email = emailFor(loss);
    for (const body of [email.html, email.text])
      expect(body.replace(/\u00a0|\u202f/g, " ")).toContain(
        "Inget att fakturera för 1–18 nov. 2026 (ingen vinst, andelen blir 0 kr).",
      );
  });

  it("med hyra: hyran står under tabellen, före totalraden", () => {
    const snap = build(OWNER, 50_000);
    expect(splitPeriodTable(snap.report.compensation)!.extras.map((x) => x.label)).toEqual([
      "Hyra",
    ]);
    const text = page(snap);
    expect(text).toMatch(
      /Er andel 50 % 34,50 kr 94,00 kr\s+Hyra [\d ]+,\d\d kr\s+Er ersättning totalt, exklusive moms/,
    );
  });

  it("en rapport från före ändringen har raderna under varandra, som förut", () => {
    const { rev: _rev, ...old } = BASIS;
    void _rev;
    const text = page(build(old));
    expect(text).toContain("14–31 okt. 2026: Försäljning");
    expect(text).not.toContain("Post 14–31 okt. 1–14 nov.");
  });

  it("en månad, olika villkor eller en andel som inte är räknad: ingen kolumntabell", () => {
    const one = buildSnapshot({
      type: "butik",
      month: "2026-11",
      organization: ORG,
      sources: sources({
        orders: [ord("2026-11-10", { amountOre: 24_900 })],
        prices: [price("t-a", 13_000, "2026-01-01")],
        agreements: [split("2026-10-14", null)],
      }),
      generatedAt: "2026-12-01T08:00:00.000Z",
      storeId: "s-1",
    });
    if (one.type !== "butik") throw new Error("fel typ");
    expect(splitPeriodTable(one.report.compensation)).toBeNull();
    const c = build(OWNER).report.compensation;
    const [a, b] = c.splits;
    expect(splitPeriodTable({ ...c, splits: [a!, { ...b!, shareBp: 4_000 }] })).toBeNull();
    expect(splitPeriodTable({ ...c, splits: [a!, { ...b!, pending: true }] })).toBeNull();
    expect(splitPeriodTable({ ...c, splits: [a!, b!, b!] })).toBeNull();
  });
});
