/**
 * Butiksrapporten som A4 (utskriftsläget i src/components/report). Bygger bara på
 * ögonblicksbilden (`StoreSnapshot`).
 *
 * Standard är den korta rapporten på en sida: rubriken med beloppet, nyckeltalen,
 * uträkningen, försäljning per vecka, automaterna och raden "Underlag per titel finns på
 * begäran." Med butikens val "Visa detaljer i rapporten" (`report.details`) visas också
 * titlarna och service, som förut. Vad som visas avgörs i `storeReportView` (@/reports).
 *
 * Under uträkningen står underlaget för butikens bokföring (`report.basis`): vilket bolag
 * som betalar, mottagaren, avtalet och momsen (@/reports/store-basis).
 *
 * Innehåller ALDRIG inköp, marginal, vinst eller andra butikers siffror, utom månadens
 * summor i ersättningen när avtalet är en vinstdelning (då är de underlaget för butikens
 * andel); testet i store-report.test.tsx kontrollerar båda.
 */

import {
  ReportFact,
  ReportKpiRow,
  ReportNote,
  ReportSection,
  ReportTable,
  ReportTitle,
  type ReportColumn,
  type ReportKpi,
} from "@/components/report/report-blocks";
import { REPORT_CONTENT_WIDTH, ReportBarChart } from "@/components/report/report-charts";
import { ReportDocument, ReportPage, type ReportLayout } from "@/components/report/report-document";
import { formatInt, formatSek, formatSekAxis } from "@/lib/format";
import type {
  CompensationStep,
  StoreCompensationBreakdown,
  StoreKpi,
  StoreMachine,
  StoreReport,
  StoreTopTitle,
} from "@/reports";
import type { StoreSnapshot } from "@/server/reports/snapshot";

import {
  agreementLine,
  asStoreBasis,
  basisNotes,
  invoiceEmptyText,
  invoiceRows,
  invoiceTitle,
  isRev2,
  isWholeMonth,
  ownerLine,
  recipientLines,
  periodText,
  pctText,
  salesNote,
  splitsOf,
  storeReportView,
  totalLabel,
} from "@/reports";
import { periodDays } from "@/domain";

import {
  SECTION_TAG,
  TITLE_TAG,
  datePeriod,
  dayLabel,
  delta,
  kronor,
  monthName,
  pct,
  periodLabel,
  periodName,
  sek,
  sekValue,
  sentence,
  type HeadingLevel,
} from "./shared";

type TitleRow = Pick<StoreTopTitle, "titleId" | "name" | "orders" | "revenueOre" | "shareBp">;

/** Titelns rad i tabellen; summeringen är butikens hela månad (topplistan + övriga). */
function titleColumns(totals: { orders: number; revenueOre: number }): ReportColumn<TitleRow>[] {
  return [
    { key: "name", header: "Titel", width: "46%", render: (t) => t.name, total: "Totalt" },
    {
      key: "orders",
      header: "Sålda pack",
      numeric: true,
      render: (t) => formatInt(t.orders),
      total: formatInt(totals.orders),
    },
    {
      key: "revenue",
      header: "Försäljning",
      numeric: true,
      render: (t) => sek(t.revenueOre),
      total: sek(totals.revenueOre),
    },
    {
      key: "share",
      header: "Andel",
      numeric: true,
      render: (t) => pct(t.shareBp),
      total: pct(10_000),
    },
  ];
}

/**
 * Topplistan plus en rad "Övriga titlar" för resten av månaden, så att tabellen summerar
 * till butikens försäljning (topplistan ensam är bara en del av den).
 */
function withOthers(
  top: readonly StoreTopTitle[],
  sales: { orders: number; revenueOre: number },
): TitleRow[] {
  const orders = sales.orders - top.reduce((n, t) => n + t.orders, 0);
  const revenueOre = sales.revenueOre - top.reduce((n, t) => n + t.revenueOre, 0);
  if (orders <= 0 && revenueOre <= 0) return [...top];
  const shareBp = 10_000 - top.reduce((n, t) => n + t.shareBp, 0);
  return [...top, { titleId: "ovriga", name: "Övriga titlar", orders, revenueOre, shareBp }];
}

/**
 * Raden under rubriken: titelns pack och andel, och vilken titel som sålde flest pack när
 * det är en annan (ordningen är efter försäljning i kronor, inte antal).
 */
function titlesAside(top: readonly StoreTopTitle[]): string {
  const first = top[0]!;
  const text = `${formatInt(first.orders)} pack, ${pct(first.shareBp)} av försäljningen.`;
  const most = [...top].sort((a, b) => b.orders - a.orders)[0]!;
  return most.titleId !== first.titleId && most.orders > first.orders
    ? `${text} Flest pack: ${most.name}, ${formatInt(most.orders)}.`
    : text;
}

function machineColumns(daysInMonth: number, totals: { orders: number; revenueOre: number }) {
  const cols: ReportColumn<StoreMachine>[] = [
    { key: "name", header: "Automat", width: "40%", render: (m) => m.name, total: "Totalt" },
    {
      key: "days",
      header: "Dagar i butiken",
      numeric: true,
      render: (m) => `${formatInt(m.placedDays)} av ${formatInt(daysInMonth)}`,
    },
    {
      key: "orders",
      header: "Sålda pack",
      numeric: true,
      render: (m) => formatInt(m.orders),
      total: formatInt(totals.orders),
    },
    {
      key: "revenue",
      header: "Försäljning",
      numeric: true,
      render: (m) => sek(m.revenueOre),
      total: sek(totals.revenueOre),
    },
  ];
  return cols;
}

const stepColumns: ReportColumn<CompensationStep>[] = [
  // Uträkningen får det mesta av bredden: "10 % av 4 047,00 kr (kundernas betalning, 63 order)".
  { key: "label", header: "Post", width: "26%", render: (s) => s.label },
  {
    key: "calc",
    header: "Uträkning",
    render: (s) => <span className="text-muted">{s.calculation}</span>,
  },
  {
    key: "amount",
    header: "Belopp",
    numeric: true,
    width: "20%",
    render: (s) => kronor(s.amountOre),
  },
];

interface SplitRow {
  key: string;
  label: string;
  amountOre: number | null;
  strong?: boolean;
}

/**
 * Vinstdelningen som en kort tabell: Försäljning, (Återbetalningar), VMB-moms, Inköp,
 * Kortavgifter, Vinst, Er andel och (Hyra). Kostnaderna visas med minustecken.
 */
export function splitRows(c: StoreCompensationBreakdown, explainLoss = false): SplitRow[] {
  const splits = splitsOf(c);
  const many = splits.length > 1;
  const rows: SplitRow[] = [];
  for (const x of splits) {
    const pre = many ? `${periodText(x.range)}: ` : "";
    const pct = pctText(x.shareBp, x.shareBp % 100 === 0 ? 0 : 1);
    // Avtal och dag: eget datum över ett månadsskifte ger en delning per månad och avtal.
    const id = `${x.validFrom}-${x.range.start}`;
    rows.push({ key: `${id}-sales`, label: `${pre}Försäljning`, amountOre: x.salesInclVatOre });
    if (x.pending) {
      rows.push({ key: `${id}-share`, label: `${pre}Er andel ${pct}`, amountOre: null });
      continue;
    }
    const refunds = x.refundsOre ?? 0;
    if (refunds !== 0)
      rows.push({ key: `${id}-refund`, label: `${pre}Återbetalningar`, amountOre: -refunds });
    if (x.vmbBeforeSplit !== false)
      rows.push({ key: `${id}-vat`, label: `${pre}VMB-moms`, amountOre: -x.vmbVatOre });
    rows.push(
      { key: `${id}-buy`, label: `${pre}Inköp`, amountOre: -x.purchasesOre },
      { key: `${id}-fee`, label: `${pre}Kortavgifter`, amountOre: -x.cardFeesOre },
      { key: `${id}-res`, label: `${pre}Vinst`, amountOre: x.profitOre, strong: true },
      {
        key: `${id}-share`,
        // Utgåva 2: förlusten förklaras på raden, inte bara i fotnoten.
        label: `${pre}Er andel ${pct}${explainLoss && x.profitOre < 0 && x.storeShareOre === 0 ? " (ingen vinst, 0 kr)" : ""}`,
        amountOre: x.storeShareOre,
      },
    );
  }
  if (c.commissionOre !== 0)
    rows.push({ key: "commission", label: "Provision", amountOre: c.commissionOre });
  if (c.rentOre !== 0) rows.push({ key: "rent", label: "Hyra", amountOre: c.rentOre });
  return rows;
}

/** En rad i vinstdelningen med en kolumn per period. */
interface SplitPeriodRow {
  key: string;
  label: string;
  /** Beloppet per period, i periodernas ordning. */
  amounts: readonly number[];
  strong?: boolean;
}

/**
 * Vinstdelningen med en kolumn per period, när rapporten har två perioder med samma villkor
 * (eget datum över ett månadsskifte: oktober och november). Hälften så många rader som
 * `splitRows`, så att rapporten får plats på ett ark, och månaderna går att jämföra rad för
 * rad. Samma belopp som i `splitRows`. null = perioderna står under varandra som förut
 * (en period, fler än två, olika andel eller VMB-val, eller en andel som inte är räknad).
 */
export function splitPeriodTable(c: StoreCompensationBreakdown): {
  periods: { key: string; label: string }[];
  rows: SplitPeriodRow[];
  /** Provision och hyra: gäller hela rapporten, står under tabellen. */
  extras: SplitRow[];
} | null {
  const splits = splitsOf(c);
  const first = splits[0];
  if (splits.length !== 2 || !first) return null;
  if (splits.some((x) => x.pending)) return null;
  const vmb = first.vmbBeforeSplit !== false;
  if (splits.some((x) => x.shareBp !== first.shareBp || (x.vmbBeforeSplit !== false) !== vmb))
    return null;
  // Året står i rapportens rubrik: kolumnerna heter "14–31 okt." och "1–14 nov.".
  const sameYear = splits.every((x) => x.range.end.slice(0, 4) === first.range.start.slice(0, 4));
  const label = (x: (typeof splits)[number]) =>
    sameYear ? periodText(x.range).replace(/\s\d{4}$/, "") : periodText(x.range);
  const pct = pctText(first.shareBp, first.shareBp % 100 === 0 ? 0 : 1);
  const row = (
    key: string,
    text: string,
    pick: (x: (typeof splits)[number]) => number,
    strong = false,
  ): SplitPeriodRow => ({
    key,
    label: text,
    amounts: splits.map(pick),
    ...(strong ? { strong } : {}),
  });
  const rows: SplitPeriodRow[] = [row("sales", "Försäljning", (x) => x.salesInclVatOre)];
  if (splits.some((x) => (x.refundsOre ?? 0) !== 0))
    rows.push(row("refund", "Återbetalningar", (x) => -(x.refundsOre ?? 0)));
  if (vmb) rows.push(row("vat", "VMB-moms", (x) => -x.vmbVatOre));
  rows.push(
    row("buy", "Inköp", (x) => -x.purchasesOre),
    row("fee", "Kortavgifter", (x) => -x.cardFeesOre),
    row("res", "Vinst", (x) => x.profitOre, true),
    row(
      "share",
      `Er andel ${pct}${splits.some((x) => x.profitOre < 0 && x.storeShareOre === 0) ? " (ingen vinst ger 0 kr)" : ""}`,
      (x) => x.storeShareOre,
    ),
  );
  const extras: SplitRow[] = [];
  if (c.commissionOre !== 0)
    extras.push({ key: "commission", label: "Provision", amountOre: c.commissionOre });
  if (c.rentOre !== 0) extras.push({ key: "rent", label: "Hyra", amountOre: c.rentOre });
  return {
    periods: splits.map((x) => ({ key: `${x.validFrom}-${x.range.start}`, label: label(x) })),
    rows,
    extras,
  };
}

function splitPeriodColumns(
  periods: readonly { key: string; label: string }[],
): ReportColumn<SplitPeriodRow>[] {
  return [
    {
      key: "label",
      header: "Post",
      render: (r) => (r.strong ? <span className="font-medium text-fg">{r.label}</span> : r.label),
    },
    ...periods.map((p, i): ReportColumn<SplitPeriodRow> => ({
      key: p.key,
      header: p.label,
      numeric: true,
      width: "31%",
      render: (r) =>
        r.strong ? (
          <span className="font-medium text-fg">{kronor(r.amounts[i]!)}</span>
        ) : (
          kronor(r.amounts[i]!)
        ),
    })),
  ];
}

const splitColumns: ReportColumn<SplitRow>[] = [
  {
    key: "label",
    header: "Post",
    render: (r) => (r.strong ? <span className="font-medium text-fg">{r.label}</span> : r.label),
  },
  {
    key: "amount",
    header: "Belopp",
    numeric: true,
    width: "30%",
    render: (r) =>
      r.amountOre === null ? (
        <span className="text-muted">i månadsrapporten</span>
      ) : r.strong ? (
        <span className="font-medium text-fg">{kronor(r.amountOre)}</span>
      ) : (
        kronor(r.amountOre)
      ),
  },
];

/**
 * Veckodiagrammet i den korta rapporten: ritat för den vänstra spalten (6 av 11 delar av
 * arkets bredd minus mellanrummet), så att texten i diagrammet behåller sin storlek. Lågt,
 * så att också den längsta uträkningen (vinstdelning med hyra) får plats på samma ark.
 */
const SHORT_CHART = { width: Math.round((REPORT_CONTENT_WIDTH - 30) * (6 / 11)), height: 88 };
/** Utgåva 2 av underlaget är högre: diagrammet är lägre, så att rapporten får plats på ett ark. */
const SHORT_CHART_REV2 = { ...SHORT_CHART, height: 72 };

/** Med fler automater än så står de i en egen tabell under veckorna. */
const SIDE_BY_SIDE_MACHINES = 3;
/** Veckodiagrammet i full bredd i den korta rapporten: lägre än i rapporten med detaljer. */
const STACKED_CHART = { width: REPORT_CONTENT_WIDTH, height: 130 };

/**
 * Fotnoten under uträkningen utan vinstdelning (utgåva 2): provisionen bara när ett avtal
 * har provision, på det kunderna betalade när momssatsen är 0 %, och hyran per dag.
 */
export function calculationNote(r: StoreReport): string {
  const commission = r.compensation.steps.some((s) => s.kind === "commission");
  const rent = r.compensation.rentOre !== 0 || r.compensation.model.endsWith("rent");
  return [
    commission
      ? r.sales.vatOre === 0
        ? "Provisionen räknas per köp på det kunderna betalade, med det avtal som gällde den dagen."
        : "Provisionen räknas per köp på beloppet exklusive moms, med det avtal som gällde den dagen."
      : "",
    rent ? "Hyran räknas per dag när avtalet gäller en del av månaden." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function StoreReportDocument({
  snapshot,
  layout = "stack",
  level = "page",
  recipient,
}: {
  snapshot: StoreSnapshot;
  layout?: ReportLayout;
  level?: HeadingLevel;
  /** Mottagarens namn i sidhuvudet. Standard: butiken. */
  recipient?: string;
}) {
  const r = snapshot.report;
  const view = storeReportView(r);
  const month = periodLabel(snapshot);
  const custom = !isWholeMonth(snapshot.period);
  const prevName = custom ? "perioden före" : monthName(r.comparison.month);
  const name = periodName(snapshot);
  const steps = r.compensation.steps.filter((s) => s.kind !== "total");
  const total = r.compensation.steps.find((s) => s.kind === "total");
  const splitList = splitsOf(r.compensation);
  const split = splitList.length > 0;
  // Med bara vinstdelning är totalen samma tal som "Er andel": raden visas inte två gånger.
  const showTotal =
    total !== undefined &&
    (!split || r.compensation.rentOre !== 0 || r.compensation.commissionOre !== 0);
  const sharesLoss = splitList.some((x) => x.lossTreatment === "proportional");
  const noVmb = split && splitList.every((x) => x.vmbBeforeSplit === false);
  const bestWeek = [...r.weeks].sort((a, b) => b.revenueOre - a.revenueOre)[0];
  const weekData = r.weeks.map((w) => ({ label: `v. ${w.week}`, value: w.revenueOre / 100 }));
  const partialWeeks = r.weeks.some((w) => w.partial);
  // Underlaget för bokföringen (saknas i äldre rapporter), se nedan.
  const basisData = asStoreBasis(r.basis);
  // Utgåva 2 med momsrad: ersättningen sägs vara exklusive moms där den står.
  const exVat = isRev2(basisData) && basisData.vatMode === "added";

  const kpis: Record<StoreKpi, ReportKpi> = {
    sales: {
      label: "Försäljning",
      value: sekValue(r.sales.revenueOre),
      unit: "kr",
      delta: delta(r.comparison.revenueChangeBp),
      context: r.comparison.revenueChangeBp === null ? undefined : `mot ${prevName}`,
    },
    orders: {
      label: "Sålda pack",
      value: formatInt(r.sales.orders),
      delta:
        r.comparison.ordersDiff === 0
          ? "±0"
          : `${r.comparison.ordersDiff > 0 ? "+" : "−"}${formatInt(Math.abs(r.comparison.ordersDiff))}`,
      context: `mot ${prevName}`,
    },
    average: {
      label: "Snittköp",
      value: r.sales.averageOrderOre === null ? "–" : sekValue(r.sales.averageOrderOre),
      unit: r.sales.averageOrderOre === null ? undefined : "kr",
    },
    compensation: {
      label: exVat ? "Er ersättning exkl. moms" : "Er ersättning",
      value: sekValue(r.compensation.totalOre),
      unit: "kr",
      context: split
        ? r.compensation.rentOre > 0
          ? "andel + hyra"
          : "andel av vinsten"
        : r.compensation.model === "commission_and_rent"
          ? "provision + hyra"
          : r.compensation.model === "commission"
            ? "provision"
            : r.compensation.model === "rent"
              ? "hyra"
              : "inget avtal",
    },
  };

  const title = (
    <ReportTitle
      as={TITLE_TAG[level]}
      eyebrow={`Butiksrapport · ${snapshot.store.name}`}
      title={view.headline}
    >
      {r.greeting ? <p className="whitespace-pre-line">{r.greeting}</p> : null}
    </ReportTitle>
  );

  const kpiRow = <ReportKpiRow items={view.kpis.map((k) => kpis[k])} />;

  // Underlaget för butikens bokföring: vem som betalar, vem som får ersättningen, avtalet
  // och momsen. Sparat i rapporten när den räknades; en äldre rapport utan uppgifterna
  // visas som förut, utan blocket.
  const vat = basisData ? invoiceRows(basisData, r) : [];
  // Ingen ersättning: blocket säger att inget ska faktureras (utgåva 2), i stället för att saknas.
  const nothingToInvoice = basisData && vat.length === 0 ? invoiceEmptyText(basisData, r) : null;
  const recipientRows = basisData ? recipientLines(basisData, snapshot.store.name) : [];
  const basisFacts = basisData ? (
    <>
      <ReportFact label="Ersättningen betalas av">
        <p className="font-medium">
          {basisData.payer.name}
          {basisData.payer.brand ? (
            <span className="font-normal text-muted">
              {" "}
              (verksamheten kallas {basisData.payer.brand})
            </span>
          ) : null}
        </p>
        {ownerLine(basisData, r.machines.length) ? (
          <p className="text-muted">{ownerLine(basisData, r.machines.length)}</p>
        ) : null}
        {/* Org.nr och momsreg.nr på samma rad när de får plats, annars på var sin. */}
        {basisData.payer.orgNumber || basisData.payer.vatNumber ? (
          <p className="tnum flex flex-wrap gap-x-[3mm] text-muted">
            {basisData.payer.orgNumber ? (
              <span className="whitespace-nowrap">Org.nr {basisData.payer.orgNumber}</span>
            ) : null}
            {basisData.payer.vatNumber ? (
              <span className="whitespace-nowrap">Momsreg.nr {basisData.payer.vatNumber}</span>
            ) : null}
          </p>
        ) : null}
        {basisData.payer.address ? (
          <p className="tnum text-muted">{basisData.payer.address}</p>
        ) : null}
      </ReportFact>
      <ReportFact label="Mottagare">
        {recipientRows.map((line, i) => (
          <p key={line} className={i === 0 ? "font-medium" : "tnum text-muted"}>
            {line}
          </p>
        ))}
      </ReportFact>
      {nothingToInvoice ? (
        <ReportFact label={invoiceTitle(basisData)}>
          <p className="text-muted">{nothingToInvoice}</p>
        </ReportFact>
      ) : vat.length > 0 ? (
        <ReportFact label={invoiceTitle(basisData)}>
          <dl className="flex flex-col">
            {vat.map((row) => (
              <div
                key={row.key}
                className={
                  row.strong
                    ? "flex items-baseline justify-between gap-[3mm] border-t border-line font-medium"
                    : "flex items-baseline justify-between gap-[3mm] text-muted"
                }
              >
                <dt>{row.label}</dt>
                <dd className="tnum font-mono text-[10.5px] whitespace-nowrap">
                  {kronor(row.amountOre)}
                </dd>
              </div>
            ))}
          </dl>
        </ReportFact>
      ) : null}
    </>
  ) : null;
  // Avtalet, betalningarna och momsen i några meningar.
  const basisNote = basisData ? (
    <p
      className={
        // Utgåva 2 har fler meningar (betalningen, platsen, VMB): något mindre, så att den
        // korta rapporten får plats på ett ark.
        isRev2(basisData)
          ? "text-[10px] leading-[13.5px] text-muted"
          : "text-[11px] leading-[15px] text-muted"
      }
    >
      {basisNotes(basisData, r, snapshot.store.name).join(" ")}
    </p>
  ) : null;
  // Den korta rapporten med vinstdelning (den längsta uträkningen): underlaget står bredvid
  // tabellen, som bara har två smala kolumner, och tabellen är något tätare. Så får också
  // åtta rader, hyra, tre automater och en lång hälsning plats på ett ark.
  const basisBeside = basisData !== null && split && !view.details;
  // Annars: ett eget block under uträkningen.
  const basis =
    basisData && !basisBeside ? (
      <section
        aria-label="Underlag för bokföringen"
        className="flex flex-col gap-[2mm] border-t border-line-strong pt-[2.5mm]"
      >
        <div
          className={
            vat.length > 3
              ? // Med "Redan betalt" och "Kvar att betala": bredare spalt för beloppen.
                "grid grid-cols-[4fr_3fr_5fr] items-start gap-[6mm]"
              : vat.length > 0 || nothingToInvoice
                ? "grid grid-cols-[5fr_3fr_4fr] items-start gap-[6mm]"
                : "grid grid-cols-[5fr_7fr] items-start gap-[6mm]"
          }
        >
          {basisFacts}
        </div>
        {basisNote}
      </section>
    ) : null;

  // Raden som avslutar uträkningen. En rapport från före utgåva 2 visar den som förut: bara
  // när totalen är mer än "Er andel" (hyra eller provision), med stegets egen rubrik.
  const rev2 = isRev2(basisData);
  // Bredvid underlaget (vinstdelning i den korta rapporten) står raden i tabellens spalt.
  const totalInColumn = rev2 && basisBeside;
  const totalRow =
    total && (rev2 || showTotal) ? (
      <div
        data-total-row
        className="flex items-baseline justify-between gap-[4mm] border-t border-line-strong pt-[2mm] text-[12px] leading-[16px]"
      >
        <span className="font-medium text-fg">{rev2 ? totalLabel(basisData) : total.label}</span>
        {showTotal && !totalInColumn ? (
          <span className="text-muted">{total.calculation}</span>
        ) : null}
        <span className="tnum font-mono font-medium whitespace-nowrap text-fg">
          {kronor(total.amountOre)}
        </span>
      </div>
    ) : null;

  // Vinstdelningens tabell: två perioder med samma villkor står bredvid varandra (utgåva 2),
  // annars under varandra som förut.
  const periodTable = rev2 && split ? splitPeriodTable(r.compensation) : null;
  // Tätare rader bredvid underlaget; utgåva 2 (högre underlag) tätast.
  const denseRows = rev2
    ? "[&_tbody_td]:py-[0.8mm]! [&_tbody_th]:py-[0.8mm]!"
    : "[&_tbody_td]:py-[1.1mm]! [&_tbody_th]:py-[1.1mm]!";
  const splitTable = (dense: boolean) =>
    periodTable ? (
      <>
        <ReportTable
          caption={`Vinstdelningen med ${snapshot.store.name} för ${name}, per period.`}
          columns={splitPeriodColumns(periodTable.periods)}
          rows={periodTable.rows}
          rowKey={(x) => x.key}
          className={dense ? denseRows : undefined}
        />
        {periodTable.extras.map((x) => (
          <div
            key={x.key}
            className="flex items-baseline justify-between gap-[4mm] text-[11px] leading-[15px]"
          >
            <span className="text-fg">{x.label}</span>
            <span className="tnum font-mono text-[10.5px] whitespace-nowrap">
              {kronor(x.amountOre ?? 0)}
            </span>
          </div>
        ))}
      </>
    ) : (
      <ReportTable
        caption={`Vinstdelningen med ${snapshot.store.name} för ${name}.`}
        columns={splitColumns}
        rows={splitRows(r.compensation, rev2)}
        rowKey={(x) => x.key}
        className={dense ? denseRows : undefined}
      />
    );

  // Utgåva 2 i den korta rapporten: avtalsraden (med villkoren) står i underlaget.
  const agreementInNote =
    rev2 && !view.details && agreementLine(basisData, snapshot.store.name, r.compensation) !== null;
  // Fotnoten med formeln (vinstdelning) eller provisionen och hyran.
  const calculationFormula = (
    <ReportNote>
      {split
        ? `${noVmb ? "Vinst = försäljning − inköp − kortavgifter." : "Vinst = försäljning − VMB-moms (20 % av försäljning minus inköp) − inköp − kortavgifter."} ${sharesLoss ? "Vid förlust bär ni er andel av förlusten." : "Ingen vinst ger 0 kr."}${
            // Utgåva 2: vad inköpet är. Med VMB dras ingen moms av på inköpen.
            rev2 && basisData.vmb === true ? " Inköp räknas med moms." : ""
          }`
        : rev2
          ? calculationNote(r)
          : `Provisionen räknas per köp på beloppet exklusive moms, med det avtal som gällde den dagen.${
              r.compensation.rentOre !== 0 || r.compensation.model.endsWith("rent")
                ? " Hyran räknas per dag när avtalet gäller en del av månaden."
                : ""
            }`}
    </ReportNote>
  );

  // Uträkningen: samma tabell i båda rapporterna (det är så butiken räknar efter sin andel).
  const calculation = (
    <ReportSection
      as={SECTION_TAG[level]}
      index={1}
      eyebrow="Ersättning"
      title={
        view.details
          ? `Er ersättning för ${name}: ${kronor(r.compensation.totalOre)}.`
          : "Så räknas ersättningen."
      }
      aside={
        // Utgåva 2 i den korta rapporten: avtalet med villkoren står i underlaget, en gång.
        agreementInNote
          ? undefined
          : split
            ? `Avtal: ${r.compensation.modelText}`
            : r.compensation.modelText
      }
      // Den korta rapporten: något tätare mellan rubrik, tabell och not (samma innehåll).
      className={view.details ? undefined : basisBeside ? "gap-[2mm]!" : "gap-[3mm]!"}
    >
      {split && basisBeside ? (
        <div className="grid grid-cols-2 items-start gap-[8mm]">
          <div className="flex min-w-0 flex-col gap-[2mm]">
            {splitTable(true)}
            {totalInColumn ? totalRow : null}
            {/* Utgåva 2: formeln står under tabellen i spalten (sparar en rad på arket). */}
            {totalInColumn ? calculationFormula : null}
          </div>
          <section aria-label="Underlag för bokföringen" className="flex flex-col gap-[2mm]">
            {basisFacts}
          </section>
        </div>
      ) : split ? (
        splitTable(false)
      ) : (
        <ReportTable
          caption={`Ersättningen till ${snapshot.store.name} uträknad steg för steg.`}
          columns={stepColumns}
          rows={steps}
          rowKey={(s, i) => `${s.kind}-${i}`}
        />
      )}
      {totalInColumn ? null : totalRow}
      {totalInColumn ? null : calculationFormula}
      {basisBeside ? basisNote : null}
    </ReportSection>
  );

  // Den korta rapporten: veckorna och automaterna står bredvid varandra (en rad, så att
  // rapporten får plats på en sida), diagrammet ritas därför för den smalare spalten.
  // `column`: diagrammet står i spalten bredvid automaterna. Då skrivs inte "Mest i vecka …"
  // ut (staplarna har sina belopp), så att rubriken ryms på en rad.
  const weeks = (chart?: { width: number; height: number }, column = false) =>
    weekData.length > 0 ? (
      <ReportSection
        as={SECTION_TAG[level]}
        index={2}
        eyebrow="Försäljning per vecka"
        title="Försäljning per vecka."
        className={column ? "gap-[3mm]!" : undefined}
        aside={
          bestWeek && bestWeek.revenueOre > 0
            ? column
              ? undefined
              : `Mest i vecka ${bestWeek.week}: ${sek(bestWeek.revenueOre)} på ${formatInt(bestWeek.orders)} köp.`
            : "Ingen försäljning under månaden."
        }
      >
        <ReportBarChart
          data={weekData}
          width={chart?.width}
          height={chart?.height}
          // Det låga diagrammet i spalten: få linjer, så att axelns tal inte går i varandra.
          tickCount={column ? 2 : undefined}
          format={formatSek}
          formatAxis={formatSekAxis}
          summary={`Försäljning per vecka i ${month}: ${r.weeks
            .map((w) => `${w.label} ${sek(w.revenueOre)}`)
            .join(", ")}.`}
        />
        {/* Den korta rapporten har noten längst ned på sidan (sparar höjd i spalten). */}
        {!chart && partialWeeks ? (
          <ReportNote>
            Veckor som bara delvis ligger i {name} räknas med de dagar som hör till{" "}
            {custom ? "perioden" : "månaden"}.
          </ReportNote>
        ) : null}
      </ReportSection>
    ) : null;

  const machines = (index: number) => (
    <ReportSection
      as={SECTION_TAG[level]}
      index={index}
      eyebrow="Automater"
      title={`${formatInt(r.machines.length)} ${r.machines.length === 1 ? "automat" : "automater"} i butiken.`}
      aside={`${formatInt(r.sales.orders)} sålda pack under ${name}.`}
    >
      <ReportTable
        caption="Butikens automater under månaden."
        columns={machineColumns(custom ? periodDays(snapshot.period) : r.compensation.daysInMonth, {
          orders: r.sales.orders,
          revenueOre: r.sales.revenueOre,
        })}
        rows={r.machines}
        rowKey={(m) => m.machineId}
      />
    </ReportSection>
  );

  // Automaterna i den korta rapporten (smal spalt): namnet och en rad per automat. Text i
  // stället för en tabell med rubriker, så att raden bryts i stället för att gå ut i
  // marginalen, och tre automater inte blir högre än veckodiagrammet bredvid.
  const daysInPeriod = custom ? periodDays(snapshot.period) : r.compensation.daysInMonth;
  const machineFacts = (index: number) => (
    <ReportSection
      as={SECTION_TAG[level]}
      index={index}
      eyebrow="Automater"
      title={`${formatInt(r.machines.length)} ${r.machines.length === 1 ? "automat" : "automater"} i butiken.`}
      className="gap-[3mm]!"
    >
      <ul className="flex flex-col border-t border-line">
        {r.machines.map((m) => (
          <li key={m.machineId} className="flex flex-col border-b border-line py-[0.8mm]">
            <p className="text-[12px] leading-[16px] text-fg">{m.name}</p>
            <p className="tnum text-[11px] leading-[15px] text-muted">
              <span className="whitespace-nowrap">
                I butiken {formatInt(m.placedDays)} av {formatInt(daysInPeriod)} dagar
              </span>
              {" · "}
              <span className="whitespace-nowrap">{formatInt(m.orders)} pack</span>
              {" · "}
              <span className="whitespace-nowrap">sålt för {sek(m.revenueOre)}</span>
            </p>
          </li>
        ))}
      </ul>
    </ReportSection>
  );

  // Utgåva 2: raden om underlag per titel står först i fotnoten (sparar höjd, så att
  // underlaget för bokföringen får plats på samma ark).
  const closingInline = rev2 && view.closing !== null;
  const footnotes = (
    <div
      className={
        closingInline
          ? "mt-auto flex flex-col gap-[1.5mm] border-t border-line pt-[2mm]"
          : "mt-auto flex flex-col gap-[1.5mm]"
      }
    >
      {view.closing && !closingInline ? (
        <p className="border-t border-line pt-[2.5mm] text-[12px] leading-[16px] text-fg">
          {view.closing}
        </p>
      ) : null}
      <ReportNote>
        {closingInline ? <span className="text-fg">{view.closing} </span> : null}
        {/* Vad försäljningssiffran är, aldrig "ingen moms tas ut" bredvid "Moms 25 %". En
            rapport från före den utgåvan står som den skrevs. */}
        {isRev2(basisData)
          ? salesNote(r, snapshot.store.name)
          : `Försäljningen är köp i automater som stod i ${snapshot.store.name} köpdagen, exklusive moms${
              r.sales.vatOre === 0 ? " (ingen moms tas ut)" : ""
            }.`}{" "}
        {custom && r.comparison.period
          ? `Perioden före (${periodText(r.comparison.period)})`
          : "Förra månaden"}
        : {sek(r.comparison.revenueOre)} på {formatInt(r.comparison.orders)} köp.
        {view.details ? null : (
          <>
            {partialWeeks
              ? ` Veckor som bara delvis ligger i ${name} räknas med de dagar som hör till ${custom ? "perioden" : "månaden"}.`
              : ""}{" "}
            Beräkningsversion {snapshot.calcVersion}.
          </>
        )}
      </ReportNote>
      {view.details ? <ReportNote>Beräkningsversion {snapshot.calcVersion}.</ReportNote> : null}
    </div>
  );

  const doc = {
    title: `Butiksrapport ${month}`,
    recipient: recipient ?? snapshot.store.name,
    // Avsändaren i sidhuvudet: bolaget som betalar, när det är sparat i rapporten.
    sender: basisData?.payer.name ?? snapshot.organization.name,
    period: datePeriod(snapshot.period),
    generatedAt: new Date(snapshot.generatedAt),
    timeZone: snapshot.organization.timeZone,
    layout,
  };

  // Den korta rapporten: en sida, bara uträkningen och summor.
  if (!view.details) {
    return (
      <ReportDocument {...doc}>
        {/* Utgåva 2 har ett högre underlag (betalningar, VMB-texten, platsen): tätast. */}
        <ReportPage className={rev2 ? "gap-[2.5mm]" : basisBeside ? "gap-[3.5mm]" : "gap-[5mm]"}>
          {title}
          {kpiRow}
          {calculation}
          {basis}
          {/* En vanlig butik: veckorna och automaterna bredvid varandra, allt på en sida.
              Med många automater står de i en tabell under (som kan delas mellan två ark). */}
          {weekData.length > 0 && r.machines.length <= SIDE_BY_SIDE_MACHINES ? (
            <div className="grid grid-cols-[6fr_5fr] items-start gap-[8mm]">
              {weeks(rev2 ? SHORT_CHART_REV2 : SHORT_CHART, true)}
              {machineFacts(3)}
            </div>
          ) : (
            weeks(STACKED_CHART)
          )}
          {weekData.length > 0 && r.machines.length <= SIDE_BY_SIDE_MACHINES
            ? null
            : machines(weekData.length > 0 ? 3 : 2)}
          {footnotes}
        </ReportPage>
      </ReportDocument>
    );
  }

  return (
    <ReportDocument {...doc}>
      <ReportPage className="gap-[8mm]">
        {title}
        {kpiRow}
        {calculation}
        {basis}
        {weeks()}
      </ReportPage>

      <ReportPage className="gap-[8mm]">
        <ReportSection
          as={SECTION_TAG[level]}
          index={3}
          eyebrow="Titlar"
          title={
            r.topTitles[0]
              ? `${r.topTitles[0].name} gav mest försäljning.`
              : "Inga titlar såldes under månaden."
          }
          aside={r.topTitles[0] ? titlesAside(r.topTitles) : undefined}
        >
          {r.topTitles.length > 0 ? (
            <ReportTable
              caption="Titlarna med mest försäljning under månaden, övriga titlar sammanslagna."
              columns={titleColumns(r.sales)}
              rows={withOthers(r.topTitles, r.sales)}
              rowKey={(t) => t.titleId}
            />
          ) : null}
        </ReportSection>

        {machines(4)}

        <ReportSection
          as={SECTION_TAG[level]}
          index={5}
          eyebrow="Service"
          title={`${formatInt(snapshot.service.refills.count)} påfyllningsbesök.`}
          aside={
            snapshot.service.refills.last
              ? sentence(`Senast ${dayLabel(snapshot.service.refills.last)}`)
              : "Ingen påfyllning registrerad under månaden."
          }
        >
          <div className="grid grid-cols-3 gap-[6mm] border-t border-line pt-[3mm]">
            <ReportFact label="Påfyllningsbesök">
              {formatInt(snapshot.service.refills.count)}
              {snapshot.service.refills.last
                ? `, senast ${dayLabel(snapshot.service.refills.last)}`
                : ""}
            </ReportFact>
            <ReportFact label="Flest köp">
              {snapshot.service.busiest ??
                `Underlaget är för litet (${formatInt(snapshot.service.busiestOrders)} köp)`}
            </ReportFact>
            <ReportFact label="Snittköp">
              {r.sales.averageOrderOre === null ? "–" : kronor(r.sales.averageOrderOre)}
            </ReportFact>
          </div>
        </ReportSection>

        {footnotes}
      </ReportPage>
    </ReportDocument>
  );
}
