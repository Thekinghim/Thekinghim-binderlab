/**
 * Butiksrapporten som underlag för butikens bokföring: vem som betalar ersättningen, vilket
 * avtal den vilar på och hur momsen hanteras. En butiks revisor godkände inte rapporten
 * utan detta ("Det visar inte från vilket bolag som ni ska få ersättning ifrån. Det framgår
 * inte om det är svenskt moms som gäller eller ej.").
 *
 * Uppgifterna läses när rapporten skapas och sparas i rapporten (`StoreReport.basis`), så
 * en godkänd eller skickad rapport ändras aldrig. En rapport från före uppgifterna fanns
 * saknar fältet och visas som förut, utan blocket.
 *
 * Här finns bara vårt bolags identitet (det som redan står i kontraktet med butiken),
 * avtalets namn och datum och momsvalet: inga belopp utöver butikens egen ersättning.
 * Ren modul: samma texter på sidan, i PDF:en, i mejlet och i butiksportalen.
 */

import { applyBp, type IsoDate, type Period } from "@/domain";

import type { StoreReport } from "./store-report";
import { dateText, krText, periodText } from "./text";

/** Momsen i butiksrapporten (Inställningar → Företaget). */
export type ReportVatMode = "added" | "none";

/** Svensk moms på butikens ersättning: 25 %. */
export const STORE_VAT_RATE_BP = 2_500;

export const REPORT_VAT_MODE_LABEL: Record<ReportVatMode, string> = {
  added: "Moms tillkommer (25 %)",
  none: "Visa ingen momsrad",
};

/** Bolaget som betalar ersättningen (vi). */
export interface BasisPayer {
  /** Juridiskt namn; utan ett sådant organisationens namn (`legal` falskt). */
  readonly name: string;
  /** Sant när `name` är företagsnamnet från Inställningar. */
  readonly legal: boolean;
  /** NNNNNN-NNNN, null = inte ifyllt. */
  readonly orgNumber: string | null;
  readonly address: string | null;
  /** Momsregistreringsnummer, bara om ett är sparat (gissas aldrig). */
  readonly vatNumber: string | null;
  /**
   * Namnet verksamheten kallas (organisationens namn i appen), när det skiljer sig från det
   * juridiska namnet. null eller saknas = samma namn, eller inget juridiskt namn ifyllt.
   */
  readonly brand?: string | null;
}

/**
 * Namnet verksamheten kallas, om det ska stå bredvid det juridiska namnet: bara när ett
 * juridiskt namn är ifyllt och organisationens namn är ett annat (skiftläge och blanksteg
 * räknas inte).
 */
export function brandOf(legalName: string | null, organizationName: string): string | null {
  const norm = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
  if (!legalName || organizationName.trim() === "") return null;
  return norm(legalName) === norm(organizationName) ? null : organizationName.trim();
}

/** "Binderlab Sverige AB (verksamheten kallas Binderlab)", eller bara namnet. */
export function payerName(basis: StoreBasis): string {
  const p = basis.payer;
  return p.brand ? `${p.name} (verksamheten kallas ${p.brand})` : p.name;
}

/**
 * Raden under bolaget som betalar: butikens revisor frågade vem som äger automaten. Bara i
 * rapporter från utgåva 2.
 */
export function ownerLine(basis: StoreBasis, machines = 1): string | null {
  if (!isRev2(basis)) return null;
  return machines > 1 ? "Äger och driver automaterna." : "Äger och driver automaten.";
}

/** Avtalet som ersättningen vilar på. */
export interface BasisContract {
  readonly title: string;
  readonly validFrom: IsoDate;
  /** Dagen avtalet undertecknades; null = registrerat för hand (dagen är inte känd). */
  readonly signedOn: IsoDate | null;
}

/**
 * Underlagets utgåva. 2: rapporten säger vad försäljningssiffran är (aldrig "ingen moms tas
 * ut"), har avtalsformen, betalningar och en totalrad. En sparad rapport utan utgåvan (från
 * före 2) visas som den visades då.
 */
export const BASIS_REV = 2;

/** En utbetalning till butiken som redan är gjord (en betald avräkning). */
export interface BasisPayment {
  /** Dagen avräkningen betalades. */
  readonly paidOn: IsoDate;
  readonly amountOre: number;
}

/** Avtalets form, butikens val (Butiker → Kontakt och rapport). */
export type AgreementForm = "written" | "oral";

export const AGREEMENT_FORM_LABEL: Record<AgreementForm, string> = {
  written: "Skriftligt avtal",
  oral: "Muntligt avtal",
};

export interface StoreBasis {
  /**
   * Butikens val av avtalsform när rapporten räknades. "oral": avtalet är muntligt, också om
   * ett kontrakt står som undertecknat (då är `contract` null). "written" eller null (inte
   * valt): `contract` gäller, om det finns. Saknas i utgåva 1.
   */
  readonly agreementForm?: AgreementForm | null;
  /**
   * Betalda avräkningar till butiken för rapportens månader, lästa när rapporten räknades
   * (store_settlements; rapporten ändrar dem aldrig). Tom eller saknas = inget är betalt.
   */
  readonly payments?: readonly BasisPayment[];
  /** Se `BASIS_REV`. Saknas = utgåva 1. */
  readonly rev?: number;
  readonly payer: BasisPayer;
  /** null = butiken har inget undertecknat avtal för perioden (raden visas inte). */
  readonly contract: BasisContract | null;
  readonly vatMode: ReportVatMode;
  /** Momssatsen i baspunkter (2 500 = 25 %). */
  readonly vatRateBp: number;
  /**
   * "Vi säljer med vinstmarginalbeskattning (VMB)" (Inställningar → Företaget) när rapporten
   * räknades. Sant: rapporten säger det (`vmbStatement`). Saknas eller falskt: bara att vi
   * är säljare av varorna.
   */
  readonly vmb?: boolean;
}

/** Momsregistreringsnumret för ett svenskt bolag: SE + organisationsnumrets tio siffror + 01. */
export function suggestedVatNumber(orgNumber: string | null | undefined): string | null {
  const digits = (orgNumber ?? "").replace(/\D/g, "");
  return digits.length === 10 ? `SE${digits}01` : null;
}

/** "SE559000123401", eller null om texten inte är ett svenskt momsregistreringsnummer. */
export function normalizeVatNumber(input: string): string | null {
  const v = input.replace(/[\s-]/g, "").toUpperCase();
  return /^SE\d{10}01$/.test(v) ? v : null;
}

/** Ett kontrakt som det står i databasen (det som avgör om det gäller och är undertecknat). */
export interface BasisContractRow {
  readonly title: string | null;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  readonly terminatedOn: IsoDate | null;
  /** Mallen kontraktet skapades från; null = registrerat för hand (räknas som undertecknat). */
  readonly template: string | null;
  /** Dagen kontraktet undertecknades (i organisationens tidszon), eller null. */
  readonly signedOn: IsoDate | null;
}

/**
 * Butikens avtal för perioden: det senaste undertecknade kontraktet som gällde någon dag i
 * perioden. Ett kontrakt från mallen räknas först när det är undertecknat; ett kontrakt
 * registrerat för hand räknas som undertecknat (som på sidan Kontrakt). Inget sådant: null.
 */
export function contractForPeriod(
  rows: readonly BasisContractRow[],
  period: Period,
): BasisContract | null {
  const live = rows
    .filter((c) => c.template === null || c.signedOn !== null)
    .filter((c) => {
      const end = [c.validTo, c.terminatedOn].filter((d): d is IsoDate => d !== null).sort()[0];
      return c.validFrom <= period.end && (end === undefined || end >= period.start);
    })
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : 0));
  const c = live[0];
  if (!c) return null;
  return {
    title: c.title && c.title.trim() ? c.title.trim() : "Placeringsavtal",
    validFrom: c.validFrom,
    signedOn: c.signedOn,
  };
}

/** Det som saknas för att rapporten ska räcka som underlag ("företagsnamn", …). */
export function basisGaps(basis: StoreBasis): string[] {
  const gaps: string[] = [];
  if (!basis.payer.legal) gaps.push("företagsnamn");
  if (!basis.payer.orgNumber) gaps.push("organisationsnummer");
  return gaps;
}

/**
 * Raderna under "Ersättningen betalas av": namn (med namnet verksamheten kallas), att bolaget
 * äger och driver automaten, org.nr, adress, momsreg.nr. `machines`: butikens automater.
 */
export function payerLines(basis: StoreBasis, machines = 1): string[] {
  const p = basis.payer;
  const owner = ownerLine(basis, machines);
  return [
    payerName(basis),
    ...(owner ? [owner] : []),
    ...(p.orgNumber ? [`Org.nr ${p.orgNumber}`] : []),
    ...(p.address ? [p.address] : []),
    ...(p.vatNumber ? [`Momsreg.nr ${p.vatNumber}`] : []),
  ];
}

/** "Enligt Placeringsavtal från 3 november 2026, undertecknat 9 november 2026." */
export function contractLine(basis: StoreBasis): string | null {
  const c = basis.contract;
  if (!c) return null;
  const signed = c.signedOn ? `, undertecknat ${dateText(c.signedOn)}` : "";
  return `Enligt ${c.title} från ${dateText(c.validFrom)}${signed}.`;
}

/**
 * Raden om avtalet som ersättningen vilar på.
 *
 * - Muntligt avtal: "Muntligt avtal mellan {bolag} och {butik}: {villkoren}." Villkoren är
 *   avtalets villkor i klartext (`compensation.termsText`); utan avtal i perioden ingen rad.
 * - Skriftligt avtal, eller inget val: det undertecknade kontraktet för perioden
 *   (`contractLine`), om det finns.
 * - Annars ingen rad (null): rapporten säger då inte vilket avtal som gäller, och
 *   granskningen varnar (`agreementMissing`).
 */
export function agreementLine(
  basis: StoreBasis,
  storeName: string,
  compensation: { readonly termsText?: string },
): string | null {
  if (basis.agreementForm === "oral") {
    const terms = compensation.termsText?.trim();
    return terms ? `Muntligt avtal mellan ${basis.payer.name} och ${storeName}: ${terms}.` : null;
  }
  return contractLine(basis);
}

/** Texten i granskningen när rapporten inte säger vilket avtal som gäller. */
export const AGREEMENT_MISSING_MESSAGE = "Rapporten säger inte vilket avtal som gäller";

/**
 * Sant när en rapport (utgåva 2) saknar raden om avtalet: avtalsformen är inte vald och inget
 * undertecknat kontrakt gäller perioden (eller formen är vald men underlaget för raden
 * saknas). En rapport från före utgåva 2 varnar inte: den hade inget val att göra.
 */
export function agreementMissing(
  basis: StoreBasis,
  storeName: string,
  compensation: { readonly termsText?: string },
): boolean {
  return isRev2(basis) && agreementLine(basis, storeName, compensation) === null;
}

/** 2 500 → "25", 1 250 → "12,5". */
function ratePct(bp: number): string {
  return String(bp / 100).replace(".", ",");
}

export interface BasisVatRow {
  /** "amount", "vat", "total", "paid-ÅÅÅÅ-MM-DD" eller "left". */
  readonly key: string;
  readonly label: string;
  readonly amountOre: number;
  /** Summarad (streck över, halvfet): "Att fakturera" och "Kvar att betala". */
  readonly strong?: boolean;
}

/**
 * Ersättningen, momsen och beloppet att fakturera. Tom utan momsrad ("Visa ingen momsrad")
 * och när det inte finns något att fakturera (ersättningen är 0 kr eller lägre).
 */
export function vatRows(basis: StoreBasis, compensationOre: number): BasisVatRow[] {
  if (basis.vatMode !== "added" || compensationOre <= 0) return [];
  const vatOre = applyBp(compensationOre, basis.vatRateBp);
  const pct = ratePct(basis.vatRateBp);
  return [
    { key: "amount", label: "Ersättning exkl. moms", amountOre: compensationOre },
    { key: "vat", label: `Moms ${pct} %`, amountOre: vatOre },
    { key: "total", label: "Att fakturera", amountOre: compensationOre + vatOre, strong: true },
  ];
}

/** Utbetalningarna per dag (flera avräkningar betalda samma dag blir en rad), äldst först. */
function paymentsByDay(basis: StoreBasis): BasisPayment[] {
  const byDay = new Map<IsoDate, number>();
  for (const p of basis.payments ?? []) {
    if (!(p.amountOre > 0) || typeof p.paidOn !== "string") continue;
    byDay.set(p.paidOn, (byDay.get(p.paidOn) ?? 0) + p.amountOre);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([paidOn, amountOre]) => ({ paidOn, amountOre }));
}

/**
 * Fakturablocket: ersättningen, momsen och beloppet att fakturera (`vatRows`), och när en
 * utbetalning redan är gjord också "Redan betalt {datum}" och "Kvar att betala" (oftast
 * momsen: butiken fick ersättningen exklusive moms innan fakturan fanns).
 *
 * Det betalda visas bara när det går ihop: summan av utbetalningarna är högst beloppet att
 * betala. Är mer betalt (avräkningen gäller en hel månad, rapporten en del av den) visas
 * blocket utan betalningarna, som förut, hellre än ett negativt "Kvar att betala".
 * Utan momsrad ("Visa ingen momsrad") börjar blocket med "Er ersättning".
 */
export function invoiceRows(basis: StoreBasis, compensationOre: number): BasisVatRow[] {
  const base = vatRows(basis, compensationOre);
  if (!isRev2(basis) || compensationOre <= 0) return base;
  const dueOre = base.length > 0 ? base[base.length - 1]!.amountOre : compensationOre;
  const paid = paymentsByDay(basis);
  const paidOre = paid.reduce((n, p) => n + p.amountOre, 0);
  if (paid.length === 0 || paidOre > dueOre) return base;
  const head: BasisVatRow[] =
    base.length > 0
      ? base
      : [{ key: "amount", label: "Er ersättning", amountOre: compensationOre, strong: true }];
  return [
    ...head,
    ...paid.map((p) => ({
      key: `paid-${p.paidOn}`,
      label: `Redan betalt ${periodText({ start: p.paidOn, end: p.paidOn })}`,
      amountOre: p.amountOre,
    })),
    { key: "left", label: "Kvar att betala", amountOre: dueOre - paidOre, strong: true },
  ];
}

/** Blockets rubrik: "Er faktura" med momsrad, annars "Betalning". */
export function invoiceTitle(basis: StoreBasis): string {
  return basis.vatMode === "added" ? "Er faktura" : "Betalning";
}

/**
 * Det bolaget säger om sin egen moms när ägaren har valt "Vi säljer med
 * vinstmarginalbeskattning (VMB)". En fast text, ord för ord: det är det ENDA stället där
 * skatteregelns namn får stå i något som når butiken (se `withoutVmbStatement`).
 */
export function vmbStatement(payerName: string): string {
  return `${payerName} är säljare av varorna i automaten och redovisar momsen på den försäljningen enligt reglerna om vinstmarginalbeskattning (VMB). Den momsen berör inte butiken. Butikens ersättning är betalning för en tjänst och omfattas inte av VMB.`;
}

/**
 * Texten utan den fasta VMB-texten, för kontrollen att inget som når butiken innehåller
 * "vinst" eller "marginal". Bara hela den fasta texten för rapportens bolag tas bort, och
 * bara när rapporten har valet på: ordet "vinstmarginalbeskattning" någon annanstans (eller
 * i en rapport utan valet) står kvar och stoppas av kontrollen som förut.
 */
export function withoutVmbStatement(text: string, basis: StoreBasis | null | undefined): string {
  if (!basis || basis.vmb !== true) return text;
  return text.split(vmbStatement(basis.payer.name)).join(" ");
}

/**
 * Meningarna om momsen. Med momsrad: beloppet är exklusive moms och butiken fakturerar oss
 * med svensk moms. Alltid: vi är säljare av varorna (försäljningen i automaten är alltså
 * inte butikens). Hur vi själva redovisar momsen på försäljningen sägs bara när ägaren har
 * valt det i Inställningar ("Vi säljer med vinstmarginalbeskattning (VMB)", `basis.vmb`):
 * appen kan inte veta det själv. Utan momsrad sägs bara vem som säljer varorna.
 */
export function vatSentences(basis: StoreBasis, compensationOre: number): string[] {
  const who = basis.payer.name;
  const seller =
    basis.vmb === true ? vmbStatement(who) : `${who} är säljare av varorna i automaten.`;
  if (basis.vatMode !== "added" || compensationOre <= 0) return [seller];
  const pct = ratePct(basis.vatRateBp);
  return [
    `Ersättningen är exklusive moms. Ni fakturerar ${who} och lägger på svensk moms, ${pct} %.`,
    seller,
  ];
}

/** Sant för en rapport sparad med utgåva 2 eller senare (se `BASIS_REV`). */
export function isRev2(basis: StoreBasis | null | undefined): basis is StoreBasis {
  return basis !== null && basis !== undefined && (basis.rev ?? 1) >= 2;
}

/**
 * Vad försäljningssiffran i rapporten är (docs/berakningar.md avsnitt 2 och 4), per avtalstyp.
 *
 * Nyckeltalet Försäljning är Σ belopp exkl. moms med momssatsen i Inställningar.
 * - Momssats över 0 %: siffran är exklusive moms. Vinstdelningen räknas ändå alltid på
 *   försäljningen inklusive moms, och det sägs då också.
 * - Momssats 0 % (kravet för VMB) och vinstdelning: ingen moms dras ur beloppet, och
 *   vinstdelningen är definierad på försäljningen inklusive moms. Siffran är det kunderna
 *   betalade, inklusive moms.
 * - Momssats 0 % utan vinstdelning (provision, hyra, inget avtal): siffran är det kunderna
 *   betalade. Om det är med eller utan moms sägs inte: appen vet inte det.
 *
 * Rapporten påstår aldrig att ingen moms tas ut.
 */
export function salesBasis(report: Pick<StoreReport, "sales" | "compensation">): {
  /** Vad nyckeltalet Försäljning är; null = sägs inte. */
  readonly kpi: "incl" | "excl" | null;
  /** Uträkningen (vinstdelning) räknar på ett annat belopp än nyckeltalet: inklusive moms. */
  readonly splitInclVat: boolean;
} {
  const split = ((report.compensation as { splits?: readonly unknown[] }).splits ?? []).length > 0;
  if (report.sales.vatOre !== 0) return { kpi: "excl", splitInclVat: split };
  return { kpi: split ? "incl" : null, splitInclVat: false };
}

/** Meningen i rapportens fotnot: "Försäljningen är kundernas köp i automater som stod i …". */
export function salesNote(
  report: Pick<StoreReport, "sales" | "compensation">,
  storeName: string,
): string {
  const { kpi, splitInclVat } = salesBasis(report);
  const what = `kundernas köp i automater som stod i ${storeName} köpdagen`;
  if (kpi === "incl") return `Försäljningen är ${what}, inklusive moms.`;
  if (kpi === null) return `Försäljningen är ${what}.`;
  if (splitInclVat)
    return `Försäljningen överst är ${what}, exklusive moms. I uträkningen räknas försäljningen inklusive moms.`;
  return `Försäljningen är ${what}, exklusive moms.`;
}

/** Kort form under nyckeltalet Försäljning (mejlet); null = ingen rad. */
export function salesVatLabel(report: Pick<StoreReport, "sales" | "compensation">): string | null {
  const { kpi } = salesBasis(report);
  return kpi === "incl" ? "Inkl. moms" : kpi === "excl" ? "Exkl. moms" : null;
}

/**
 * Raden som avslutar uträkningen. Med momsrad är beloppet exklusive moms (momsen läggs på i
 * fakturan); utan momsrad sägs ingenting om moms.
 */
export function totalLabel(basis: StoreBasis): string {
  return basis.vatMode === "added"
    ? "Er ersättning totalt, exklusive moms"
    : "Er ersättning totalt";
}

/** Blocket som text, rad för rad (mejlets textdel och tester). */
export function basisText(
  basis: StoreBasis,
  storeName: string,
  compensationOre: number,
  compensation: { readonly termsText?: string } = {},
  machines = 1,
): string[] {
  const contract = agreementLine(basis, storeName, compensation);
  return [
    `Ersättningen betalas av: ${payerLines(basis, machines).join(", ")}`,
    `Mottagare: ${storeName}`,
    ...(contract ? [contract] : []),
    ...invoiceRows(basis, compensationOre).map(
      (r) => `${r.label}: ${krText(r.amountOre, "always")}`,
    ),
    ...vatSentences(basis, compensationOre),
  ];
}

/** Sparat värde → underlaget, eller null om det saknas eller har ett okänt format. */
export function asStoreBasis(value: unknown): StoreBasis | null {
  const b = value as Partial<StoreBasis> | null | undefined;
  if (!b || typeof b !== "object" || !b.payer || typeof b.payer.name !== "string") return null;
  if (b.vatMode !== "added" && b.vatMode !== "none") return null;
  if (typeof b.vatRateBp !== "number") return null;
  return b as StoreBasis;
}
