/**
 * Rapportmejlet: ögonblicksbilden → props till e-postmallen i src/emails
 * (`renderReportEmail`). Alla tal kommer ur ögonblicksbilden (som i sin tur kommer ur
 * @/reports), så mejlet visar samma siffror som PDF:en. Ren modul.
 *
 * Mallen har fält som Binderlab ännu inte har underlag för (andel i drift, nästa besök,
 * kassaflödets in- och utgående kassa). De lämnas som saknade värden (NaN / ogiltigt
 * datum), aldrig som påhittade siffror, och raderna tas sedan bort ur det renderade
 * mejlet (./email-cleanup).
 *
 * Ämnesraden är kort ("Butiksrapport oktober 2026 · Spelbutiken"); slutsatsen står överst
 * i mejlet. Avregistrering sker med ett svar till avsändaren (mailto), eftersom
 * mottagarna inte har konto i appen.
 */

import type {
  EmailAttachment,
  EmailKpi,
  EmailMachineRow,
  ReportEmailProps,
  Sender,
} from "@/emails/report-content";
import { formatInt, formatKronor, formatMonth, MINUS } from "@/lib/format";
import { isWholeMonth, periodText, sie4Verifications } from "@/reports";
import type { Period as DatePeriod } from "@/lib/period";

import { TYPE_LABEL } from "./kinds";
import type {
  AccountantSnapshot,
  PartnerSnapshot,
  ReportSnapshot,
  StoreSnapshot,
} from "./snapshot";

/** Saknat värde i mallen: formatteras som "–". */
const MISSING_NUMBER = Number.NaN;
const MISSING_DATE = new Date(Number.NaN);

export interface EmailContext {
  /** Mottagarens namn i hälsningen ("Hej Maria,"). */
  readonly recipientName: string;
  /** Länk till rapporten. */
  readonly reportUrl: string;
  /** Kort följetext under hälsningen. Utan text används en standardmening. */
  readonly followText?: string | null;
  /** Rapportens kortnummer i sidhuvudet. */
  readonly reportId: string;
  /** Bilagorna som skickas med (namn och storlek). */
  readonly attachments: readonly EmailAttachment[];
  readonly sender?: Sender;
  /** Kontaktperson hos operatören (butiksmejlet). */
  readonly contact?: { readonly name: string; readonly phone: string | null } | null;
}

/** 'ÅÅÅÅ-MM-DD' → lokal midnatt (samma konvention som src/lib/period). */
export function localDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

function datePeriod(snapshot: ReportSnapshot): DatePeriod {
  return { start: localDate(snapshot.period.start), end: localDate(snapshot.period.end) };
}

const kr = (ore: number) => ore / 100;
const share = (bp: number | null) => (bp === null ? MISSING_NUMBER : bp / 10_000);
const change = (bp: number | null) => (bp === null ? undefined : { value: bp / 10_000 });

/** Kort ämnesrad: "Butiksrapport oktober 2026 · Spelbutiken". */
export function reportSubject(snapshot: ReportSnapshot): string {
  const month = isWholeMonth(snapshot.period)
    ? formatMonth(localDate(snapshot.period.start), { year: "always" })
    : periodText(snapshot.period);
  const who = snapshot.type === "butik" ? snapshot.store.name : snapshot.organization.name;
  return `${TYPE_LABEL[snapshot.type]} ${month} · ${who}`;
}

/**
 * Avregistrering utan inloggning: ett förifyllt svar till avsändaren. Mottagarna saknar
 * konto i appen, så en länk dit skulle inte fungera.
 */
export function unsubscribeMailto(
  snapshot: ReportSnapshot,
  email: string | undefined,
): string | undefined {
  const to = email?.trim();
  if (!to) return undefined;
  const subject = `Avregistrera: ${TYPE_LABEL[snapshot.type].toLocaleLowerCase("sv-SE")}`;
  const body = "Jag vill inte längre få den här rapporten via e-post.";
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function base(snapshot: ReportSnapshot, ctx: EmailContext) {
  const unsubscribeUrl = unsubscribeMailto(snapshot, ctx.sender?.email);
  return {
    subject: reportSubject(snapshot),
    ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
    recipientName: ctx.recipientName,
    period: datePeriod(snapshot),
    summary: snapshot.report.conclusion.text,
    reportUrl: ctx.reportUrl,
    attachments: [...ctx.attachments],
    reportId: ctx.reportId,
    generatedAt: new Date(snapshot.generatedAt),
    sender: ctx.sender,
    ...(ctx.followText && ctx.followText.trim() !== "" ? { intro: ctx.followText.trim() } : {}),
  };
}

/**
 * Butikens länk går till butiksportalen (/portal), där butiken ser sina godkända
 * rapporter. /rapport/<id> kräver ett konto i panelen, som butiken inte har.
 */
export function portalUrlFor(reportUrl: string): string {
  try {
    return `${new URL(reportUrl).origin}/portal`;
  } catch {
    return reportUrl;
  }
}

function storeEmail(s: StoreSnapshot, ctx: EmailContext): ReportEmailProps {
  const r = s.report;
  const kpis: EmailKpi[] = [
    {
      label: "Försäljning",
      value: kr(r.sales.revenueOre),
      unit: "kr",
      change: change(r.comparison.revenueChangeBp),
      note: r.sales.vatOre === 0 ? "Ingen moms" : `Exkl. moms`,
    },
    {
      label: "Sålda pack",
      value: r.sales.orders,
      unit: "count",
      note:
        r.comparison.ordersDiff === 0
          ? isWholeMonth(s.period)
            ? "Lika många som förra månaden"
            : "Lika många som perioden före"
          : `${r.comparison.ordersDiff > 0 ? "+" : MINUS}${formatInt(Math.abs(r.comparison.ordersDiff))} ${isWholeMonth(s.period) ? "mot förra månaden" : "mot perioden före"}`,
    },
    {
      label: "Er ersättning",
      value: kr(r.compensation.totalOre),
      unit: "kr",
      decimals: 2,
      note: r.compensation.modelText,
    },
  ];
  const rows: EmailMachineRow[] = r.machines.map((m) => ({
    id: m.name,
    name: s.store.name,
    revenue: kr(m.revenueOre),
    packs: m.orders,
  }));
  const refillsLast = s.service.refills.last ? localDate(s.service.refills.last) : MISSING_DATE;
  return {
    ...base(s, ctx),
    reportUrl: portalUrlFor(ctx.reportUrl),
    recipientKind: "butik",
    intro:
      ctx.followText?.trim() ||
      (r.greeting ??
        `Här är månadens försäljning i ${s.store.name} och er ersättning, uträknad steg för steg i den bifogade rapporten.`),
    kpis,
    rows,
    details: {
      siteName: s.store.name,
      availability: MISSING_NUMBER,
      incidents: [],
      busiest: s.service.busiest ?? "–",
      refills: { count: s.service.refills.count, last: refillsLast },
      nextVisit: MISSING_DATE,
      contact: {
        name: ctx.contact?.name ?? ctx.sender?.name ?? "Binderlab",
        phone: ctx.contact?.phone ?? "–",
      },
    },
  };
}

/** Verifikationsnummer per konto ("A1–A19"), om SIE-exporten går att skapa. */
function verificationsByAccount(s: AccountantSnapshot): Map<string, string> {
  const out = new Map<string, string>();
  if (s.missingAccounts.length > 0) return out;
  let list;
  try {
    list = sie4Verifications(s.report, s.sie);
  } catch {
    return out;
  }
  const numbers = new Map<string, number[]>();
  for (const v of list) {
    for (const t of v.transactions) {
      const arr = numbers.get(t.account) ?? [];
      if (!arr.includes(v.number)) arr.push(v.number);
      numbers.set(t.account, arr);
    }
  }
  for (const [account, nums] of numbers) {
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const series = s.sie.verificationSeries;
    out.set(account, min === max ? `${series}${min}` : `${series}${min}–${series}${max}`);
  }
  return out;
}

function accountantEmail(s: AccountantSnapshot, ctx: EmailContext): ReportEmailProps {
  const t = s.report.totals;
  const accounts = new Map(s.sie.ledgerAccounts.map((a) => [a.key, a]));
  const vers = verificationsByAccount(s);
  const entry = (key: string, text: string, amountOre: number) => {
    const account = accounts.get(key)?.account ?? "–";
    return { account, text, amount: kr(amountOre), verification: vers.get(account) ?? "–" };
  };
  const entries = [
    entry("sales", `Försäljning exkl. moms, ${formatInt(t.orders)} order`, t.netOre),
    ...(t.vatOre !== 0 ? [entry("vat_out", "Utgående moms", -t.vatOre)] : []),
    ...(t.feesOre !== 0 ? [entry("card_fees", "Kortavgifter", -t.feesOre)] : []),
    entry("store_commission", "Provision till butiker", -t.commissionOre),
    entry("rent", "Hyra till butiker", -t.rentOre),
    entry(
      "cogs",
      `Inköpsvärde sålda pack (${formatInt(t.pricedOrders)} order med pris)`,
      -t.costOre,
    ),
  ];
  const kpis: EmailKpi[] = [
    {
      label: "Försäljning",
      value: kr(t.grossOre),
      unit: "kr",
      decimals: 2,
      note: `Moms ${formatKronor(kr(t.vatOre))} · ${formatInt(t.orders)} order`,
    },
    {
      label: "Butiksersättning",
      value: kr(t.compensationOre),
      unit: "kr",
      decimals: 2,
    },
    { label: "Inköp", value: kr(t.costOre), unit: "kr", decimals: 2 },
    {
      label: "Order",
      value: t.orders,
      unit: "count",
      ...(t.unpricedOrders > 0
        ? { note: `Varav ${formatInt(t.unpricedOrders)} utan inköpspris` }
        : {}),
      ...(s.report.reconciliation.ok ? {} : { alert: "Avstämningen mot Awish har avvikelser" }),
    },
  ];
  const rows: EmailMachineRow[] = s.report.machines.map((m) => ({
    id: m.name,
    name: m.storeNames.join(", ") || "–",
    revenue: kr(m.grossOre),
    revenueExVat: kr(m.netOre),
  }));
  return {
    ...base(s, ctx),
    recipientKind: "bokforing",
    intro:
      ctx.followText?.trim() ||
      `Här är underlaget för månaden: försäljning per dag, butiksersättning och avstämning mot Awish. PDF, Excel och SIE 4 är bifogade.`,
    kpis,
    rows,
    details: { company: s.organization.name, entries, transactions: t.orders },
  };
}

function partnerEmail(s: PartnerSnapshot, ctx: EmailContext): ReportEmailProps {
  const r = s.report.result;
  const prev = s.report.previousMonth;
  const kpis: EmailKpi[] = [
    {
      label: "Intäkt",
      value: kr(r.totalRevenueOre),
      unit: "kr",
      change: change(prev?.totalRevenueChangeBp ?? null),
    },
    {
      label: r.profitOre < 0 ? "Förlust" : "Vinst",
      value: kr(r.profitOre),
      unit: "kr",
      change: change(prev?.profitChangeBp ?? null),
    },
    {
      label: "Marginal",
      value: share(r.marginBp),
      unit: "share",
      ...(prev?.marginDiffBp !== null && prev?.marginDiffBp !== undefined
        ? { change: { value: prev.marginDiffBp / 10_000, kind: "points" as const } }
        : {}),
    },
  ];
  const machineRows = s.report.machines.filter((m) => m.kind === "item");
  const rows: EmailMachineRow[] = [...machineRows]
    .sort((a, b) => b.revenueOre - a.revenueOre)
    .slice(0, 5)
    .map((m) => ({
      id: m.name,
      name: "",
      revenue: kr(m.revenueOre + m.unpricedRevenueOre),
      margin: m.marginBp === null ? undefined : m.marginBp / 10_000,
    }));
  const plan = [
    ...s.report.events
      .filter((e) => e.severity === "warning")
      .map((e) => ({ title: e.text.replace(/\.$/, "") })),
    ...(s.comment
      ? s.comment
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => ({ title: line }))
      : []),
  ];
  return {
    ...base(s, ctx),
    recipientKind: "delagare",
    intro:
      ctx.followText?.trim() ||
      `Här är månadens resultat med jämförelser, lönsamhet per automat och titel och vinstfördelningen. Hela rapporten är bifogad som PDF.`,
    kpis,
    rows,
    rowsTotal: machineRows.length,
    details: {
      result: [
        { label: "Intäkt med inköpspris", amount: kr(r.revenueOre) },
        { label: "Inköp", amount: -kr(r.costOre) },
        ...(r.feesOre !== 0 ? [{ label: "Avgifter", amount: -kr(r.feesOre) }] : []),
        { label: "Butiksersättning", amount: -kr(r.compensationOre) },
        { label: r.profitOre < 0 ? "Förlust" : "Vinst", amount: kr(r.profitOre), total: true },
      ],
      margin: share(r.marginBp),
      cash: {
        opening: MISSING_NUMBER,
        inflow: MISSING_NUMBER,
        outflow: MISSING_NUMBER,
        closing: MISSING_NUMBER,
      },
      plan,
    },
  };
}

/** Props till `renderReportEmail` för en rapport. */
export function reportEmailProps(snapshot: ReportSnapshot, ctx: EmailContext): ReportEmailProps {
  switch (snapshot.type) {
    case "butik":
      return storeEmail(snapshot, ctx);
    case "bokforing":
      return accountantEmail(snapshot, ctx);
    case "delagare":
      return partnerEmail(snapshot, ctx);
  }
}
