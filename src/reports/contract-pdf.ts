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

import { NBSP } from "@/lib/format";

import { dateText, krText } from "./text";

/**
 * Andelen exakt, som den skrevs: 5 000 → "50 %", 1 250 → "12,5 %", 1 225 → "12,25 %".
 * Ett kontrakt får aldrig avrunda butikens andel.
 */
export function shareText(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const rest = Math.abs(bp % 100);
  const decimals = rest === 0 ? "" : `,${String(rest).padStart(2, "0").replace(/0$/, "")}`;
  return `${whole}${decimals}${NBSP}%`;
}

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

/** Vad butikens andel räknas på: vinsten efter kostnader (standard) eller omsättningen exkl. moms. */
export type ContractShareBase = "profit_after_costs" | "net_excl_vat";

/**
 * Kontraktets ersättning, som ägaren väljer i Skapa kontrakt och Ny butik. Samma värden
 * sparas i store_agreements (commission_bp, commission_base, loss_treatment,
 * vmb_before_split, monthly_rent_ore), så PDF:en och butiksrapporten räknar lika.
 */
export interface ContractTerms {
  /** Butikens andel i bp (5 000 = 50 %). null = ingen andel (bara hyra). */
  readonly shareBp: number | null;
  /** Vad andelen räknas på. Saknas = vinsten efter kostnader. */
  readonly base?: ContractShareBase;
  /** Vid förlust (bara vinstdelning). */
  readonly lossTreatment: "zero" | "proportional";
  /** Dra av VMB-moms från vinsten före delningen (bara vinstdelning). Saknas = falskt. */
  readonly vmbBeforeSplit?: boolean;
  /** Fast hyra per månad (öre), null = ingen. */
  readonly monthlyRentOre: number | null;
}

export interface ContractTemplateInput extends ContractTerms {
  /** Vi (operatören): organisationens namn och organisationsnummer. */
  readonly operator: ContractParty;
  /** Butiken. */
  readonly store: ContractParty;
  readonly validFrom: IsoDate;
  /** Särskilda villkor (fritext), ett eget avsnitt i avtalet. null/tomt = inget avsnitt. */
  readonly specialTerms?: string | null;
  /** Kort referens som står på avtalet (avtalets id, första 8 tecknen). */
  readonly reference: string;
}

/** Snabbvalen i Skapa kontrakt och Ny butik. */
export type ContractPreset = "split" | "rent" | "sales";

export const CONTRACT_PRESETS: Readonly<
  Record<ContractPreset, { readonly label: string; readonly terms: ContractTerms }>
> = {
  split: {
    label: "50/50 vinst",
    terms: {
      shareBp: 5_000,
      base: "profit_after_costs",
      lossTreatment: "zero",
      vmbBeforeSplit: false,
      monthlyRentOre: null,
    },
  },
  rent: {
    label: "Fast hyra",
    terms: {
      shareBp: null,
      base: "net_excl_vat",
      lossTreatment: "zero",
      vmbBeforeSplit: false,
      monthlyRentOre: null,
    },
  },
  sales: {
    label: "Procent av omsättning",
    terms: {
      shareBp: null,
      base: "net_excl_vat",
      lossTreatment: "zero",
      vmbBeforeSplit: false,
      monthlyRentOre: null,
    },
  },
};

function hasShare(t: ContractTerms): t is ContractTerms & { shareBp: number } {
  return t.shareBp !== null && t.shareBp > 0;
}

function hasRent(t: ContractTerms): t is ContractTerms & { monthlyRentOre: number } {
  return t.monthlyRentOre !== null && t.monthlyRentOre > 0;
}

function isSplit(t: ContractTerms): boolean {
  return (t.base ?? "profit_after_costs") === "profit_after_costs" && hasShare(t);
}

/**
 * Villkoren i klartext för listan: "50 % av vinsten efter kostnader",
 * "10 % av omsättningen exkl. moms", "Fast hyra 1 500 kr/mån", eller båda med "+".
 */
export function contractTermsPlain(t: ContractTerms): string {
  const parts: string[] = [];
  if (hasShare(t)) {
    parts.push(
      isSplit(t)
        ? `${shareText(t.shareBp)} av vinsten efter kostnader`
        : `${shareText(t.shareBp)} av omsättningen exkl. moms`,
    );
  }
  if (hasRent(t)) {
    parts.push(
      parts.length > 0
        ? `${krText(t.monthlyRentOre)}/mån`
        : `Fast hyra ${krText(t.monthlyRentOre)}/mån`,
    );
  }
  if (parts.length === 0) return "Inga villkor";
  const extra: string[] = [];
  if (isSplit(t) && t.lossTreatment === "proportional") extra.push("delar förlust");
  if (isSplit(t) && t.vmbBeforeSplit === true) extra.push("VMB dras först");
  return parts.join(" + ") + (extra.length > 0 ? ` (${extra.join(", ")})` : "");
}

/** Särskilda villkor som stycken (en rad = ett stycke), utan tomma rader. */
export function specialTermsParagraphs(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

export interface ContractSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

/**
 * Definitionen av vinsten, som den står i avtalet (och visas i dialogen). Standard: ingen
 * VMB-moms dras före delningen.
 */
export const PROFIT_DEFINITION =
  "Vinst = försäljning inklusive moms − återbetalningar till kunder − inköpspris för sålda varor − kort- och betalningsavgifter. Moms enligt vinstmarginalbeskattning (VMB) dras inte före delningen; den betalas av Operatören. Vinsten räknas per kalendermånad.";

/** Definitionen när avtalet drar av VMB-momsen före delningen (avtalets val). */
export const PROFIT_DEFINITION_VMB =
  "Vinst = försäljning inklusive moms − återbetalningar till kunder − moms enligt vinstmarginalbeskattning (VMB) − inköpspris för sålda varor − kort- och betalningsavgifter. Vinsten räknas per kalendermånad.";

/** Vinstens definition enligt avtalets val (`vmbBeforeSplit`, standard falskt). */
export function profitDefinition(vmbBeforeSplit: boolean | undefined = false): string {
  return vmbBeforeSplit === true ? PROFIT_DEFINITION_VMB : PROFIT_DEFINITION;
}

function lossText(lossTreatment: ContractTemplateInput["lossTreatment"], shareBp: number): string {
  return lossTreatment === "zero"
    ? "Är vinsten negativ en månad får Butiken 0 kr för den månaden. Förlusten förs inte vidare."
    : `Är vinsten negativ en månad bär Butiken ${shareText(shareBp)} av förlusten den månaden. Förlusten förs inte vidare till kommande månader.`;
}

/** Försäljningen som andelen räknas på när den gäller omsättningen. */
export const SALES_DEFINITION =
  "Omsättning = automatens försäljning exklusive moms, minus återbetalningar till kunder. Den räknas per kalendermånad.";

/** Avsnitt 4: ersättningen enligt villkoren. */
function paymentParagraphs(input: ContractTerms): string[] {
  const out: string[] = [];
  if (hasShare(input) && isSplit(input)) {
    out.push(
      `Butiken får ${shareText(input.shareBp)} av vinsten från automaten. Operatören behåller ${shareText(10_000 - input.shareBp)}.`,
      profitDefinition(input.vmbBeforeSplit),
      lossText(input.lossTreatment, input.shareBp),
    );
  } else if (hasShare(input)) {
    out.push(`Butiken får ${shareText(input.shareBp)} av automatens omsättning.`, SALES_DEFINITION);
  }
  if (hasRent(input)) {
    out.push(
      out.length > 0
        ? `Utöver andelen betalar Operatören en fast hyra på ${krText(input.monthlyRentOre)} per månad (exklusive moms).`
        : `Operatören betalar Butiken en fast hyra på ${krText(input.monthlyRentOre)} per månad (exklusive moms) för platsen.`,
    );
  }
  return out;
}

function purposeText(input: ContractTerms): string {
  const base =
    "Operatören placerar en varuautomat för samlarkort (till exempel Pokémon) i Butikens lokal. Butiken upplåter plats och el.";
  if (hasShare(input) && isSplit(input)) return `${base} Parterna delar på vinsten från automaten.`;
  if (hasShare(input)) return `${base} Butiken får en andel av försäljningen.`;
  return `${base} Operatören betalar hyra för platsen.`;
}

function reportText(input: ContractTerms): string {
  const contents =
    hasShare(input) && isSplit(input)
      ? `försäljning, ${input.vmbBeforeSplit === true ? "VMB-moms, " : ""}inköp, avgifter, vinst och Butikens andel`
      : hasShare(input)
        ? "försäljning, återbetalningar och Butikens andel"
        : "hyran";
  return `Operatören skickar en rapport för varje månad och betalar ut Butikens ersättning senast den ${CONTRACT_PAYOUT_DAY} i månaden efter. Rapporten visar ${contents}.`;
}

/** Avtalets avsnitt i ordning. */
export function contractSections(input: ContractTemplateInput): ContractSection[] {
  const payment = paymentParagraphs(input);
  const special = specialTermsParagraphs(input.specialTerms);
  const tail: ContractSection[] =
    special.length > 0
      ? [
          { heading: "8. Särskilda villkor", paragraphs: special },
          { heading: "9. Övrigt", paragraphs: [OTHER_TEXT] },
        ]
      : [{ heading: "8. Övrigt", paragraphs: [OTHER_TEXT] }];
  return [
    {
      heading: "1. Vad avtalet gäller",
      paragraphs: [purposeText(input)],
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
        reportText(input),
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
    ...tail,
  ];
}

const OTHER_TEXT =
  "Ändringar i avtalet ska vara skriftliga och godkända av båda parter. Svensk lag gäller. Avtalet är upprättat i två likalydande exemplar, ett till vardera parten, eller signeras digitalt.";

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
<meta name="viewport" content="width=device-width,initial-scale=1">
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
  readonly shareBp: number | null;
  readonly base?: ContractShareBase;
  readonly lossTreatment: ContractTemplateInput["lossTreatment"];
  readonly vmbBeforeSplit?: boolean;
  readonly monthlyRentOre?: number | null;
}): string {
  const t: ContractTerms = { ...input, monthlyRentOre: input.monthlyRentOre ?? null };
  const lines: string[] = [];
  if (hasShare(t) && isSplit(t)) {
    lines.push(
      `Vinstdelning: butiken får ${shareText(t.shareBp)} av vinsten efter kostnader.`,
      profitDefinition(t.vmbBeforeSplit),
      lossText(t.lossTreatment, t.shareBp),
    );
  } else if (hasShare(t)) {
    lines.push(`Andel av omsättningen: butiken får ${shareText(t.shareBp)}.`, SALES_DEFINITION);
  }
  if (hasRent(t)) lines.push(`Fast hyra ${krText(t.monthlyRentOre)} per månad.`);
  lines.push(
    `Rapport och utbetalning senast den ${CONTRACT_PAYOUT_DAY} i månaden efter. Uppsägningstid ${CONTRACT_NOTICE_MONTHS} månad.`,
  );
  return lines.join("\n");
}
