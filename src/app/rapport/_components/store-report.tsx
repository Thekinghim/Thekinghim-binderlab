/**
 * Butiksrapporten som A4 (utskriftsläget i src/components/report). Bygger bara på
 * ögonblicksbilden (`StoreSnapshot`): försäljning, ersättning steg för steg, titlar,
 * automater och service. Innehåller ALDRIG inköp, marginal, vinst eller andra butikers
 * siffror, utom månadens summor i ersättningen när avtalet är en vinstdelning (då är de
 * underlaget för butikens andel); testet i store-report.test.tsx kontrollerar båda.
 */

import {
  ReportFact,
  ReportKpiRow,
  ReportNote,
  ReportSection,
  ReportTable,
  ReportTitle,
  type ReportColumn,
} from "@/components/report/report-blocks";
import { ReportBarChart } from "@/components/report/report-charts";
import { ReportDocument, ReportPage, type ReportLayout } from "@/components/report/report-document";
import { formatInt, formatSek, formatSekAxis } from "@/lib/format";
import type {
  CompensationStep,
  StoreCompensationBreakdown,
  StoreMachine,
  StoreTopTitle,
} from "@/reports";
import type { StoreSnapshot } from "@/server/reports/snapshot";

import { periodText, pctText, splitsOf } from "@/reports";

import {
  SECTION_TAG,
  TITLE_TAG,
  datePeriod,
  dayLabel,
  delta,
  kronor,
  monthLabel,
  monthName,
  pct,
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
  { key: "label", header: "Post", width: "30%", render: (s) => s.label },
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
export function splitRows(c: StoreCompensationBreakdown): SplitRow[] {
  const splits = splitsOf(c);
  const many = splits.length > 1;
  const rows: SplitRow[] = [];
  for (const x of splits) {
    const pre = many ? `${periodText(x.range)}: ` : "";
    const pct = pctText(x.shareBp, x.shareBp % 100 === 0 ? 0 : 1);
    const id = x.validFrom;
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
      { key: `${id}-share`, label: `${pre}Er andel ${pct}`, amountOre: x.storeShareOre },
    );
  }
  if (c.commissionOre !== 0)
    rows.push({ key: "commission", label: "Provision", amountOre: c.commissionOre });
  if (c.rentOre !== 0) rows.push({ key: "rent", label: "Hyra", amountOre: c.rentOre });
  return rows;
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
  const month = monthLabel(snapshot.month);
  const prevName = monthName(r.comparison.month);
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

  return (
    <ReportDocument
      title={`Butiksrapport ${month}`}
      recipient={recipient ?? snapshot.store.name}
      sender={snapshot.organization.name}
      period={datePeriod(snapshot.period)}
      generatedAt={new Date(snapshot.generatedAt)}
      timeZone={snapshot.organization.timeZone}
      layout={layout}
    >
      <ReportPage className="gap-[8mm]">
        <ReportTitle
          as={TITLE_TAG[level]}
          eyebrow={`Butiksrapport · ${snapshot.store.name}`}
          title={r.conclusion.text}
        >
          {r.greeting ? <p className="whitespace-pre-line">{r.greeting}</p> : null}
        </ReportTitle>

        <ReportKpiRow
          items={[
            {
              label: "Försäljning",
              value: sekValue(r.sales.revenueOre),
              unit: "kr",
              delta: delta(r.comparison.revenueChangeBp),
              context: r.comparison.revenueChangeBp === null ? undefined : `mot ${prevName}`,
            },
            {
              label: "Sålda pack",
              value: formatInt(r.sales.orders),
              delta:
                r.comparison.ordersDiff === 0
                  ? "±0"
                  : `${r.comparison.ordersDiff > 0 ? "+" : "−"}${formatInt(Math.abs(r.comparison.ordersDiff))}`,
              context: `mot ${prevName}`,
            },
            {
              label: "Snittköp",
              value: r.sales.averageOrderOre === null ? "–" : sekValue(r.sales.averageOrderOre),
              unit: r.sales.averageOrderOre === null ? undefined : "kr",
            },
            {
              label: "Er ersättning",
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
          ]}
        />

        <ReportSection
          as={SECTION_TAG[level]}
          index={1}
          eyebrow="Ersättning"
          title={`Er ersättning för ${monthName(snapshot.month)}: ${kronor(r.compensation.totalOre)}.`}
          aside={split ? `Avtal: ${r.compensation.modelText}` : r.compensation.modelText}
        >
          {split ? (
            <ReportTable
              caption={`Vinstdelningen med ${snapshot.store.name} för ${monthName(snapshot.month)}.`}
              columns={splitColumns}
              rows={splitRows(r.compensation)}
              rowKey={(x) => x.key}
            />
          ) : (
            <ReportTable
              caption={`Ersättningen till ${snapshot.store.name} uträknad steg för steg.`}
              columns={stepColumns}
              rows={steps}
              rowKey={(s, i) => `${s.kind}-${i}`}
            />
          )}
          {total && showTotal ? (
            <div className="flex items-baseline justify-between gap-[4mm] border-t border-line-strong pt-[2mm] text-[12px] leading-[16px]">
              <span className="font-medium text-fg">{total.label}</span>
              <span className="text-muted">{total.calculation}</span>
              <span className="tnum font-mono font-medium text-fg">{kronor(total.amountOre)}</span>
            </div>
          ) : null}
          <ReportNote>
            {split
              ? `${noVmb ? "Vinst = försäljning − inköp − kortavgifter." : "Vinst = försäljning − VMB-moms (20 % av försäljning minus inköp) − inköp − kortavgifter."} ${sharesLoss ? "Vid förlust bär ni er andel av förlusten." : "Ingen vinst ger 0 kr."}`
              : "Provisionen räknas per köp på beloppet exklusive moms, med det avtal som gällde den dagen. Hyran räknas per dag när avtalet gäller en del av månaden."}
          </ReportNote>
        </ReportSection>

        {weekData.length > 0 ? (
          <ReportSection
            as={SECTION_TAG[level]}
            index={2}
            eyebrow="Försäljning per vecka"
            title="Försäljning per vecka."
            aside={
              bestWeek && bestWeek.revenueOre > 0
                ? `Mest i vecka ${bestWeek.week}: ${sek(bestWeek.revenueOre)} på ${formatInt(bestWeek.orders)} köp.`
                : "Ingen försäljning under månaden."
            }
          >
            <ReportBarChart
              data={weekData}
              format={formatSek}
              formatAxis={formatSekAxis}
              summary={`Försäljning per vecka i ${month}: ${r.weeks
                .map((w) => `${w.label} ${sek(w.revenueOre)}`)
                .join(", ")}.`}
            />
            {r.weeks.some((w) => w.partial) ? (
              <ReportNote>
                Veckor som bara delvis ligger i {monthName(snapshot.month)} räknas med de dagar som
                hör till månaden.
              </ReportNote>
            ) : null}
          </ReportSection>
        ) : null}
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

        <ReportSection
          as={SECTION_TAG[level]}
          index={4}
          eyebrow="Automater"
          title={`${formatInt(r.machines.length)} ${r.machines.length === 1 ? "automat" : "automater"} i butiken.`}
          aside={`${formatInt(r.sales.orders)} sålda pack under ${monthName(snapshot.month)}.`}
        >
          <ReportTable
            caption="Butikens automater under månaden."
            columns={machineColumns(r.compensation.daysInMonth, {
              orders: r.sales.orders,
              revenueOre: r.sales.revenueOre,
            })}
            rows={r.machines}
            rowKey={(m) => m.machineId}
          />
        </ReportSection>

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

        <div className="mt-auto flex flex-col gap-[1.5mm]">
          <ReportNote>
            Försäljningen är köp i automater som stod i {snapshot.store.name} köpdagen, exklusive
            moms
            {r.sales.vatOre === 0 ? " (ingen moms tas ut)" : ""}. Förra månaden:{" "}
            {sek(r.comparison.revenueOre)} på {formatInt(r.comparison.orders)} köp.
          </ReportNote>
          <ReportNote>Beräkningsversion {snapshot.calcVersion}.</ReportNote>
        </div>
      </ReportPage>
    </ReportDocument>
  );
}
