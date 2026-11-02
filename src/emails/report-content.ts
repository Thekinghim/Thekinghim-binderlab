/**
 * Innehåll och text för rapportmejlet, utan React. Delas av HTML-mallen
 * (report-email.tsx), textversionen och förhandsvisningen på /design, så
 * att ämnesrad, förhandstext och siffror alltid är desamma.
 */

import {
  EN_DASH,
  MINUS,
  NBSP,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatDelta,
  formatDuration,
  formatInt,
  formatKronor,
  formatMonth,
  formatNumber,
  formatPercent,
  formatPeriod,
  formatSek,
  formatTime,
} from "@/lib/format";
import { isFullMonth, normalizePeriod, type Period } from "@/lib/period";

// ---------------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------------

/** butik: centrumledningen där automaten står. bokforing: bokhållaren. delagare: delägaren. */
export type RecipientKind = "butik" | "bokforing" | "delagare";

export type KpiChange = {
  /** relative: 0.124 = +12,4 %. points: skillnad i andel, 0.004 = +0,4 procentenheter. */
  value: number;
  kind?: "relative" | "points";
};

export type EmailKpi = {
  label: string;
  value: number;
  /** kr: kronor. share: andel 0–1, visas i procent. count: antal. */
  unit: "kr" | "share" | "count";
  /** Decimaler. Standard: kr 0, share 1, count 0. */
  decimals?: number;
  change?: KpiChange;
  /** Lägre är bättre (avbrott, svinn): pilen visar riktning, ordet "bättre/sämre" följer detta. */
  lowerIsBetter?: boolean;
  /** Kort kontext under värdet, t.ex. "Exkl. moms 105 120 kr". */
  note?: string;
  /** Kräver uppmärksamhet. Texten visas med signalmarkör, så status inte bara är färg. */
  alert?: string;
};

/** En automat i tabellen. Belopp i kronor inklusive moms om inget annat anges. */
export type EmailMachineRow = {
  id: string;
  /** Platsens namn, t.ex. "Nordstan" */
  name: string;
  /** Stad, eller placering i centrumet för butiksmejlet */
  location?: string;
  revenue: number;
  revenueExVat?: number;
  /** Förändring i intäkt mot jämförelseperioden (relativ) */
  change?: number;
  /** Bruttomarginal 0–1 */
  margin?: number;
  packs?: number;
  /** Andel av öppettiden i drift 0–1 */
  availability?: number;
};

export type EmailAttachment = {
  name: string;
  /** Storlek i byte */
  size: number;
  description?: string;
};

export type DailyPoint = {
  date: Date;
  value: number;
  /** Förklaring om dagen är den markerade (högsta), t.ex. "nytt släpp" */
  note?: string;
};

export type Incident = { start: Date; durationMs: number; cause: string };

export type StoreDetails = {
  siteName: string;
  /** Andel av centrumets öppettid som automaterna tog betalt, 0–1 */
  availability: number;
  incidents: Incident[];
  /** Tider med flest köp, t.ex. "Lördagar 13–16" */
  busiest: string;
  refills: { count: number; last: Date };
  nextVisit: Date;
  contact: { name: string; phone: string };
};

export type LedgerEntry = {
  account: string;
  text: string;
  /** Belopp i kronor med öre. Kostnader negativa. */
  amount: number;
  verification: string;
};

export type LedgerDetails = {
  company: string;
  entries: LedgerEntry[];
  transactions: number;
};

export type OwnerDetails = {
  /** Resultaträkning uppifrån och ned. Sista raden med total: true är resultatet. */
  result: Array<{ label: string; amount: number; total?: boolean }>;
  margin: number;
  cash: { opening: number; inflow: number; outflow: number; closing: number };
  plan: Array<{ title: string; detail?: string; amount?: number }>;
};

export type Sender = {
  name: string;
  /** Postadress på en rad */
  address: string;
  email: string;
};

type BaseProps = {
  recipientName: string;
  period: Period;
  /** Andra, grå delen av rubriken. Ett påstående med siffra: "Intäkten ökade 12,4 % mot september." */
  summary: string;
  kpis: EmailKpi[];
  rows: EmailMachineRow[];
  /** Antal automater totalt när rows är ett urval ("5 av 14") */
  rowsTotal?: number;
  daily?: DailyPoint[];
  reportUrl: string;
  attachments?: EmailAttachment[];
  /** Standard: mottagartypens ämnesrad med period och summary */
  subject?: string;
  /** Standard: nyckeltalen på en rad */
  preheader?: string;
  intro?: string;
  reportId?: string;
  generatedAt?: Date;
  sender?: Sender;
  unsubscribeUrl?: string;
};

export type ReportEmailProps =
  | (BaseProps & { recipientKind: "butik"; details: StoreDetails })
  | (BaseProps & { recipientKind: "bokforing"; details: LedgerDetails })
  | (BaseProps & { recipientKind: "delagare"; details: OwnerDetails });

// ---------------------------------------------------------------------------
// Konstanter
// ---------------------------------------------------------------------------

export const RECIPIENT_KINDS: ReadonlyArray<{ value: RecipientKind; label: string }> = [
  { value: "butik", label: "Butik" },
  { value: "bokforing", label: "Bokföring" },
  { value: "delagare", label: "Delägare" },
];

/** Avsändare tills bolagsuppgifterna finns i inställningarna. */
export const DEFAULT_SENDER: Sender = {
  name: "Binderlab AB",
  address: "Box 1234, 111 22 Stockholm",
  email: "rapporter@binderlab.se",
};

export const ARROW_UP = "▲";
export const ARROW_DOWN = "▼";

const WEEKDAYS_LONG = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];

// ---------------------------------------------------------------------------
// Formatering
// ---------------------------------------------------------------------------

export function capitalize(s: string): string {
  return s.charAt(0).toLocaleUpperCase("sv-SE") + s.slice(1);
}

export function formatKpiValue(k: EmailKpi): string {
  switch (k.unit) {
    case "kr":
      return k.decimals ? formatKronor(k.value, { decimals: k.decimals }) : formatSek(k.value);
    case "share":
      return formatPercent(k.value, k.decimals ?? 1);
    case "count":
      return formatNumber(k.value, k.decimals ?? 0);
  }
}

/** +12,4 % · −0,9 p.e. · ±0,0 % */
export function formatChange(c: KpiChange): string {
  if (c.kind === "points") {
    const pts = c.value * 100;
    const isZero = Number(Math.abs(pts).toFixed(1)) === 0;
    const sign = isZero ? "±" : pts > 0 ? "+" : MINUS;
    return `${sign}${formatDecimal(Math.abs(pts))}${NBSP}p.e.`;
  }
  return formatDelta(c.value, 1);
}

/** ▲, ▼ eller ingenting vid oförändrat. */
export function changeGlyph(c: KpiChange): string {
  // Samma avrundning som formatChange, så att ±0 inte får en pil.
  const shown = Number((c.value * 100).toFixed(1));
  return shown > 0 ? ARROW_UP : shown < 0 ? ARROW_DOWN : "";
}

/** Om förändringen är en förbättring (styr bara ordval, aldrig ensam färg). */
export function isImprovement(c: KpiChange, lowerIsBetter = false): boolean {
  return lowerIsBetter ? c.value < 0 : c.value > 0;
}

/** 214 kB · 1,2 MB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return EN_DASH;
  if (bytes < 1000) return `${formatInt(bytes)}${NBSP}B`;
  if (bytes < 1_000_000) return `${formatInt(bytes / 1000)}${NBSP}kB`;
  return `${formatDecimal(bytes / 1_000_000)}${NBSP}MB`;
}

/** Lördag 24 okt. */
export function formatLongDay(d: Date): string {
  return `${capitalize(WEEKDAYS_LONG[d.getDay()] ?? "")} ${formatDate(d, { year: "never" })}`;
}

// ---------------------------------------------------------------------------
// Härledd text
// ---------------------------------------------------------------------------

/** "Oktober 2026." */
export function periodTitle(period: Period): string {
  return `${capitalize(formatPeriod(period))}.`;
}

/** "mot september" för hela månader, annars "mot föregående period". */
export function compareLabel(period: Period): string {
  const p = normalizePeriod(period);
  if (!isFullMonth(p)) return "mot föregående period";
  const prev = new Date(p.start.getFullYear(), p.start.getMonth() - 1, 1);
  return `mot ${formatMonth(prev, { year: "never" })}`;
}

/** "oktobers" eller "periodens" (genitiv i löptext). */
export function periodGenitive(period: Period): string {
  const p = normalizePeriod(period);
  return isFullMonth(p) ? `${formatMonth(p.start, { year: "never" })}s` : "periodens";
}

/** "november" eller "nästa period". */
export function nextPeriodName(period: Period): string {
  const p = normalizePeriod(period);
  if (!isFullMonth(p)) return "nästa period";
  return formatMonth(new Date(p.start.getFullYear(), p.start.getMonth() + 1, 1), {
    year: "never",
  });
}

/** Eyebrow i två delar: rapporttyp och omfattning. */
export function eyebrow(props: ReportEmailProps): [string, string] {
  switch (props.recipientKind) {
    case "butik":
      return ["Månadsrapport", props.details.siteName];
    case "bokforing":
      return ["Bokföringsunderlag", props.details.company];
    case "delagare":
      return ["Månadsrapport", `${formatInt(props.rowsTotal ?? props.rows.length)} automater`];
  }
}

export function buildSubject(props: ReportEmailProps): string {
  if (props.subject) return props.subject;
  const period = formatPeriod(props.period);
  switch (props.recipientKind) {
    case "butik":
      return `${props.details.siteName}, ${period}. ${props.summary}`;
    case "bokforing":
      return `Bokföringsunderlag ${period}. ${props.summary}`;
    case "delagare":
      return `Månadsrapport ${period}. ${props.summary}`;
  }
}

/** Förhandstexten som visas efter ämnesraden i inkorgen. */
export function buildPreheader(props: ReportEmailProps): string {
  if (props.preheader) return props.preheader;
  return props.kpis.map((k) => `${k.label} ${formatKpiValue(k)}`).join(" · ");
}

export function buildIntro(props: ReportEmailProps): string {
  if (props.intro) return props.intro;
  const gen = periodGenitive(props.period);
  switch (props.recipientKind) {
    case "butik":
      return `Här är ${gen} siffror för automaterna i ${props.details.siteName}. Försäljningen anges inklusive moms och är underlaget för omsättningshyran.`;
    case "bokforing":
      return `Här är underlaget för ${formatPeriod(props.period)}: ${formatInt(props.details.transactions)} försäljningar, avgifter och hyror, med verifikationsnummer och bilagor.`;
    case "delagare":
      return `Här är ${gen} resultat, kassaflöde och planen för ${nextPeriodName(props.period)}.`;
  }
}

export function buildReason(props: ReportEmailProps, sender: Sender): string {
  switch (props.recipientKind) {
    case "butik":
      return `Du får detta mejl eftersom du är kontaktperson för ${props.details.siteName} i avtalet om automatplats med ${sender.name}.`;
    case "bokforing":
      return `Du får detta mejl eftersom du sköter bokföringen för ${props.details.company}.`;
    case "delagare":
      return `Du får detta mejl eftersom du är delägare i ${sender.name}.`;
  }
}

export function ctaLabel(kind: RecipientKind): string {
  return kind === "bokforing" ? "Öppna underlaget" : "Öppna rapporten";
}

export function unsubscribeHref(props: ReportEmailProps): string {
  if (props.unsubscribeUrl) return props.unsubscribeUrl;
  try {
    return `${new URL(props.reportUrl).origin}/installningar/utskick`;
  } catch {
    return props.reportUrl;
  }
}

/** Länken utan protokoll, för textraden under knappen. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** Den markerade dagen i stapelraden: högsta värdet. */
export function peakDay(daily: ReadonlyArray<DailyPoint>): number {
  let best = 0;
  daily.forEach((d, i) => {
    if (d.value > (daily[best]?.value ?? -Infinity)) best = i;
  });
  return best;
}

/** "Lördag 24 okt. var högsta dagen: 6 980 kr, nytt släpp." */
export function peakCaption(daily: ReadonlyArray<DailyPoint>): string {
  const p = daily[peakDay(daily)];
  if (!p) return "";
  return `${formatLongDay(p.date)} var högsta dagen: ${formatSek(p.value)}${p.note ? `, ${p.note}` : ""}.`;
}

/** "1–31 okt." för stapelradens metadata. */
export function dailyRange(daily: ReadonlyArray<DailyPoint>): string {
  const first = daily[0];
  const last = daily[daily.length - 1];
  if (!first || !last) return "";
  return formatPeriod({ start: first.date, end: last.date }).replace(/\s\d{4}$/, "");
}

export function incidentLine(i: Incident): string {
  return `${formatDate(i.start, { year: "never" })} ${formatTime(i.start)} · ${keepTogether(formatDuration(i.durationMs))} · ${i.cause}`;
}

/** Hårda mellanslag, så att "2 h 44 min" inte bryts mitt i. */
function keepTogether(s: string): string {
  return s.replace(/ /g, NBSP);
}

/** "1 fil" · "3 filer" */
export function fileCount(n: number): string {
  return n === 1 ? "1 fil" : `${formatInt(n)} filer`;
}

export function incidentsSummary(incidents: ReadonlyArray<Incident>): string {
  if (incidents.length === 0) return "Inga";
  const total = incidents.reduce((acc, i) => acc + i.durationMs, 0);
  const count =
    incidents.length === 1 ? "1 tillfälle" : `${formatInt(incidents.length)} tillfällen`;
  return `${count}, totalt ${keepTogether(formatDuration(total))}`;
}

// ---------------------------------------------------------------------------
// Tabellkolumner per mottagare
// ---------------------------------------------------------------------------

export type RowColumn = {
  label: string;
  value: (r: EmailMachineRow) => string;
  /**
   * Andra rad i samma cell, i mindre grå text (antal pack under
   * försäljningen, förändring under intäkten). Två värden i en cell gör
   * tabellen smal nog för 375 px utan media query (Gmail) och 320 px med.
   */
  sub?: (r: EmailMachineRow) => RowSub | undefined;
};

export type RowSub = {
  text: string;
  /** Pil framför texten (förändring) */
  glyph?: string;
  /** Förbättring skrivs i förgrundsfärg, försämring i dämpad. Status bärs alltid av pil och tecken. */
  good?: boolean;
};

export function rowColumns(kind: RecipientKind): RowColumn[] {
  switch (kind) {
    case "butik":
      return [
        {
          label: "Försäljning",
          value: (r) => formatSek(r.revenue),
          sub: (r) =>
            r.packs === undefined ? undefined : { text: `${formatInt(r.packs)}${NBSP}pack` },
        },
        {
          label: "I drift",
          value: (r) => (r.availability === undefined ? EN_DASH : formatPercent(r.availability)),
        },
      ];
    case "bokforing":
      return [
        { label: "Inkl. moms", value: (r) => formatKronor(r.revenue) },
        {
          label: "Exkl. moms",
          value: (r) => (r.revenueExVat === undefined ? EN_DASH : formatKronor(r.revenueExVat)),
        },
      ];
    case "delagare":
      return [
        {
          label: "Intäkt",
          value: (r) => formatSek(r.revenue),
          sub: (r) =>
            r.change === undefined
              ? undefined
              : {
                  text: formatDelta(r.change, 1),
                  glyph: changeGlyph({ value: r.change }),
                  good: r.change > 0,
                },
        },
        {
          label: "Marginal",
          value: (r) => (r.margin === undefined ? EN_DASH : formatPercent(r.margin)),
        },
      ];
  }
}

export function rowsTitle(props: ReportEmailProps): string {
  if (props.recipientKind === "delagare") {
    return `Topp ${formatInt(props.rows.length)} automater`;
  }
  return props.recipientKind === "bokforing" ? "Försäljning per automat" : "Per automat";
}

export function rowsMeta(props: ReportEmailProps): string | undefined {
  if (props.rowsTotal && props.rowsTotal > props.rows.length) {
    return `${formatInt(props.rows.length)} av ${formatInt(props.rowsTotal)}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Textversion
// ---------------------------------------------------------------------------

function heading(index: number, title: string): string {
  return `${String(index).padStart(2, "0")} / ${title.toLocaleUpperCase("sv-SE")}`;
}

/** text/plain-delen av mejlet. Samma innehåll som HTML, i samma ordning. */
export function renderReportText(props: ReportEmailProps): string {
  const sender = props.sender ?? DEFAULT_SENDER;
  const cmp = compareLabel(props.period);
  const [kindLabel, scope] = eyebrow(props);
  const out: string[] = [];
  let n = 0;
  const section = (title: string) => {
    n += 1;
    out.push("", heading(n, title), "");
  };

  out.push(`${sender.name.replace(/ AB$/, "")} · ${kindLabel} · ${scope}`, "");
  out.push(`${periodTitle(props.period)} ${props.summary}`, "");
  out.push(`Hej ${props.recipientName},`, buildIntro(props));

  section("Nyckeltal");
  for (const k of props.kpis) {
    const parts = [`${k.label}: ${formatKpiValue(k)}`];
    if (k.change) parts.push(`(${formatChange(k.change)} ${cmp})`);
    let line = parts.join(" ");
    if (k.note) line += ` · ${k.note}`;
    out.push(line);
    if (k.alert) out.push(`  Obs: ${k.alert}`);
  }

  if (props.daily && props.daily.length > 0) {
    section(props.recipientKind === "butik" ? "Försäljning per dag" : "Intäkt per dag");
    out.push(peakCaption(props.daily));
  }

  section(rowsTitle(props));
  const cols = rowColumns(props.recipientKind);
  props.rows.forEach((r, i) => {
    const values = cols.map((c) => {
      const sub = c.sub?.(r);
      return `${c.label.toLocaleLowerCase("sv-SE")} ${c.value(r)}${sub ? ` (${sub.text})` : ""}`;
    });
    const rank = props.recipientKind === "delagare" ? `${i + 1}. ` : "";
    out.push(
      `${rank}${r.id} ${r.name}${r.location ? `, ${r.location}` : ""}: ${values.join(", ")}`,
    );
  });

  switch (props.recipientKind) {
    case "butik": {
      const d = props.details;
      section("Drift och service");
      out.push(`I drift: ${formatPercent(d.availability)} av öppettiden`);
      out.push(`Avbrott: ${incidentsSummary(d.incidents)}`);
      for (const i of d.incidents) out.push(`  ${incidentLine(i)}`);
      out.push(`Mest besökt: ${d.busiest}`);
      out.push(
        `Påfyllningar: ${formatInt(d.refills.count)}, senast ${formatLongDay(d.refills.last).toLocaleLowerCase("sv-SE")}`,
      );
      out.push(`Nästa besök: ${formatLongDay(d.nextVisit)} ${formatTime(d.nextVisit)}`);
      out.push(`Kontakt: ${d.contact.name}, ${d.contact.phone}`);
      break;
    }
    case "bokforing": {
      section("Sammanställning");
      for (const e of props.details.entries) {
        out.push(`${e.account} ${e.text}: ${formatKronor(e.amount)} (${e.verification})`);
      }
      break;
    }
    case "delagare": {
      const d = props.details;
      section("Resultat");
      for (const r of d.result) out.push(`${r.label}: ${formatSek(r.amount)}`);
      out.push(`Marginal: ${formatPercent(d.margin)}`);
      section("Kassaflöde");
      const p = normalizePeriod(props.period);
      out.push(`Kassa ${formatDate(p.start, { year: "never" })}: ${formatSek(d.cash.opening)}`);
      out.push(`In: ${formatSek(d.cash.inflow)}`);
      out.push(`Ut: ${formatSek(-Math.abs(d.cash.outflow))}`);
      out.push(`Kassa ${formatDate(p.end, { year: "never" })}: ${formatSek(d.cash.closing)}`);
      section(`Plan för ${nextPeriodName(props.period)}`);
      d.plan.forEach((item, i) => {
        const amount = item.amount === undefined ? "" : ` (${formatSek(item.amount)})`;
        out.push(`${i + 1}. ${item.title}${amount}`);
        if (item.detail) out.push(`   ${item.detail}`);
      });
      break;
    }
  }

  if (props.attachments && props.attachments.length > 0) {
    section("Bifogat");
    for (const a of props.attachments) {
      out.push(`${a.name} (${formatBytes(a.size)})${a.description ? `: ${a.description}` : ""}`);
    }
  }

  out.push("", `${ctaLabel(props.recipientKind)}: ${props.reportUrl}`);

  out.push("", "--", `${sender.name} · ${sender.address} · ${sender.email}`);
  out.push(buildReason(props, sender));
  out.push(`Avregistrera: ${unsubscribeHref(props)}`);
  const meta = [
    props.generatedAt ? `Skapad ${formatDateTime(props.generatedAt, { year: "always" })}` : "",
    props.reportId ? `Rapport ${props.reportId}` : "",
  ].filter(Boolean);
  if (meta.length) out.push(meta.join(" · "));

  return `${out.join("\n")}\n`;
}
