/**
 * Placeringsavtalet (Skapa avtal under Avtal och Expansion): mallens text och HTML:en som
 * skrivs ut som PDF (src/server/pdf/render.ts, renderHtml). Rent: samma indata ger samma
 * dokument. Mallen är kort och på vanlig svenska; den ska ha lästs en gång av Talenom
 * eller en jurist innan den används (står i dialogen, inte i avtalet).
 *
 * Ersättningen är vinstdelningen i docs/berakningar.md avsnitt 4:
 *   vinst = försäljning inkl. moms − VMB-moms − inköpspris för sålda pack − kort- och
 *   betalavgifter, per kalendermånad; butikens andel = andel × vinst, 0 vid förlust
 *   ('zero') eller andel × förlust ('proportional').
 */

import type { IsoDate } from "@/domain";

import { dateText, krText, pctText } from "./text";

/** Mallens namn och version (sparas på avtalet, contracts.template). */
export const CONTRACT_TEMPLATE = "placering-vinstdelning-v1";

/** Uppsägningstid i mallen. */
export const CONTRACT_NOTICE_MONTHS = 1;

/** Dag i månaden då rapport och utbetalning ska vara klara. */
export const CONTRACT_PAYOUT_DAY = 15;

export interface ContractParty {
  readonly name: string;
  readonly orgNumber?: string | null;
  readonly address?: string | null;
  readonly contactName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
}

export interface ContractTemplateInput {
  /** Vi (operatören): organisationens namn och organisationsnummer. */
  readonly operator: ContractParty;
  /** Butiken. */
  readonly store: ContractParty;
  readonly validFrom: IsoDate;
  /** Butikens andel i bp (5 000 = 50 %). */
  readonly shareBp: number;
  readonly lossTreatment: "zero" | "proportional";
  /** Fast hyra per månad (öre), null = ingen. */
  readonly monthlyRentOre: number | null;
  /** Kort referens som står på avtalet (avtalets id, första 8 tecknen). */
  readonly reference: string;
}

export interface ContractSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

/** Definitionen av vinsten, som den står i avtalet (och visas i dialogen). */
export const PROFIT_DEFINITION =
  "Vinst = försäljning inklusive moms − återbetalningar till kunder − moms enligt vinstmarginalbeskattning (VMB) − inköpspris för sålda varor − kort- och betalningsavgifter. Vinsten räknas per kalendermånad.";

function lossText(lossTreatment: ContractTemplateInput["lossTreatment"], shareBp: number): string {
  return lossTreatment === "zero"
    ? "Är vinsten negativ en månad får Butiken 0 kr för den månaden. Förlusten förs inte vidare."
    : `Är vinsten negativ en månad bär Butiken ${pctText(shareBp)} av förlusten den månaden. Förlusten förs inte vidare till kommande månader.`;
}

/** Avtalets avsnitt i ordning. */
export function contractSections(input: ContractTemplateInput): ContractSection[] {
  const share = pctText(input.shareBp);
  const ours = pctText(10_000 - input.shareBp);
  const payment: string[] = [
    `Butiken får ${share} av vinsten från automaten. Operatören behåller ${ours}.`,
    PROFIT_DEFINITION,
    lossText(input.lossTreatment, input.shareBp),
  ];
  if (input.monthlyRentOre !== null && input.monthlyRentOre > 0) {
    payment.push(
      `Utöver vinstdelningen betalar Operatören en fast hyra på ${krText(input.monthlyRentOre)} per månad (exklusive moms).`,
    );
  }
  return [
    {
      heading: "1. Vad avtalet gäller",
      paragraphs: [
        "Operatören placerar en varuautomat för samlarkort (till exempel Pokémon) i Butikens lokal. Butiken upplåter plats och el. Parterna delar på vinsten från automaten.",
      ],
    },
    {
      heading: "2. Operatörens ansvar",
      paragraphs: [
        "Operatören äger automaten och varorna i den. Operatören sköter påfyllning, lager, service, reparationer och kundärenden, och står för kostnaderna för detta.",
      ],
    },
    {
      heading: "3. Butikens ansvar",
      paragraphs: [
        "Butiken ger automaten en överenskommen plats och ett vanligt eluttag, och står för elen. Butiken håller automaten tillgänglig för kunderna under öppettiderna och släpper in Operatören för påfyllning och service.",
        "Butiken meddelar Operatören så snart som möjligt om automaten är trasig, skadad eller tom.",
      ],
    },
    { heading: "4. Ersättning till Butiken", paragraphs: payment },
    {
      heading: "5. Rapport och utbetalning",
      paragraphs: [
        `Operatören skickar en rapport för varje månad och betalar ut Butikens andel senast den ${CONTRACT_PAYOUT_DAY} i månaden efter. Rapporten visar försäljning, VMB-moms, inköp, avgifter, vinst och Butikens andel.`,
        "Butiken anger det konto utbetalningen ska gå till. Butiken får på begäran se underlaget för rapporten.",
      ],
    },
    {
      heading: "6. Försäkring och skador",
      paragraphs: [
        "Operatören försäkrar automaten och varorna. Butiken ansvarar för skador som Butiken eller dess personal orsakar med avsikt eller genom vårdslöshet. Ingen av parterna ansvarar för den andra partens uteblivna vinst eller andra indirekta skador.",
      ],
    },
    {
      heading: "7. Avtalstid och uppsägning",
      paragraphs: [
        `Avtalet gäller från ${dateText(input.validFrom)} tills vidare. Båda parter kan säga upp det med ${CONTRACT_NOTICE_MONTHS} månads uppsägningstid. Uppsägningen ska vara skriftlig; e-post räcker.`,
        "Bryter en part väsentligt mot avtalet och rättar inte detta inom 14 dagar efter skriftlig påminnelse, får den andra parten säga upp avtalet med omedelbar verkan.",
        "När avtalet upphör hämtar Operatören automaten inom 14 dagar. Butikens andel för den sista perioden betalas ut med den sista rapporten.",
      ],
    },
    {
      heading: "8. Övrigt",
      paragraphs: [
        "Ändringar i avtalet ska vara skriftliga och godkända av båda parter. Svensk lag gäller. Avtalet är upprättat i två likalydande exemplar, ett till vardera parten, eller signeras digitalt.",
      ],
    },
  ];
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text till HTML (allt användarinnehåll går hit). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const BLANK = "_______________________";

function partyHtml(role: string, p: ContractParty): string {
  const line = (label: string, value: string | null | undefined) =>
    `<div class="row"><span class="k">${label}</span><span>${value ? escapeHtml(value) : BLANK}</span></div>`;
  return `<div class="party">
  <div class="role">${role}</div>
  <div class="name">${escapeHtml(p.name)}</div>
  ${line("Org.nr", p.orgNumber)}
  ${line("Adress", p.address)}
  ${line("Kontakt", p.contactName)}
  ${line("E-post", p.email)}
  ${line("Telefon", p.phone)}
</div>`;
}

function signatureHtml(p: ContractParty): string {
  return `<div class="sign">
  <div class="role">För ${escapeHtml(p.name)}</div>
  <div class="line">Ort och datum</div>
  <div class="line">Underskrift</div>
  <div class="line">Namnförtydligande</div>
</div>`;
}

/** Hela avtalet som fristående HTML (inga externa resurser) för utskrift som A4-PDF. */
export function contractHtml(input: ContractTemplateInput): string {
  const sections = contractSections(input)
    .map(
      (s) =>
        `<section><h2>${escapeHtml(s.heading)}</h2>${s.paragraphs
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join("")}</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<title>Placeringsavtal ${escapeHtml(input.store.name)}</title>
<style>
  @page { size: A4; margin: 22mm 20mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10.5pt/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; }
  h1 { font-size: 18pt; font-weight: 600; margin: 0 0 2mm; }
  .ref { color: #555; font-size: 9pt; margin-bottom: 8mm; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; margin-bottom: 6mm; }
  .role { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: #555; }
  .name { font-size: 12pt; font-weight: 600; margin: 1mm 0 2mm; }
  .row { display: flex; gap: 3mm; font-size: 9.5pt; }
  .k { width: 18mm; color: #555; flex: none; }
  .named { font-size: 9.5pt; color: #333; margin-bottom: 6mm; }
  section { break-inside: avoid; margin-bottom: 4mm; }
  h2 { font-size: 11pt; font-weight: 600; margin: 0 0 1mm; }
  p { margin: 0 0 1.5mm; }
  .signs { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-top: 10mm; break-inside: avoid; }
  .line { border-top: 1px solid #111; margin-top: 14mm; padding-top: 1mm; font-size: 8.5pt; color: #555; }
</style>
</head>
<body>
<h1>Placeringsavtal för varuautomat</h1>
<div class="ref">Avtal ${escapeHtml(input.reference)} · gäller från ${escapeHtml(dateText(input.validFrom))}</div>
<div class="parties">
${partyHtml("Operatören", input.operator)}
${partyHtml("Butiken", input.store)}
</div>
<p class="named">Nedan kallade Operatören och Butiken.</p>
${sections}
<div class="signs">
${signatureHtml(input.operator)}
${signatureHtml(input.store)}
</div>
</body>
</html>`;
}

/** Kort sammanfattning som sparas i avtalets villkor (contracts.terms) och visas i listan. */
export function contractTermsSummary(input: {
  readonly shareBp: number;
  readonly lossTreatment: ContractTemplateInput["lossTreatment"];
  readonly monthlyRentOre?: number | null;
}): string {
  return [
    `Vinstdelning: butiken får ${pctText(input.shareBp)} av vinsten efter kostnader.`,
    PROFIT_DEFINITION,
    lossText(input.lossTreatment, input.shareBp),
    ...(input.monthlyRentOre != null && input.monthlyRentOre > 0
      ? [`Fast hyra ${krText(input.monthlyRentOre)} per månad.`]
      : []),
    `Rapport och utbetalning senast den ${CONTRACT_PAYOUT_DAY} i månaden efter. Uppsägningstid ${CONTRACT_NOTICE_MONTHS} månad.`,
  ].join("\n");
}
