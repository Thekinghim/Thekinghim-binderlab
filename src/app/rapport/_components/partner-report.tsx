/**
 * Delägarrapporten som A4: resultat mot förra månaden och samma månad i fjol (eget datum:
 * mot lika många dagar före och samma datum i fjol),
 * 6–12 månaders utveckling, lönsamhet per automat och titel, lagervärde, händelser,
 * vinstfördelning enligt ägarandelar och en egen kommentar.
 */

import {
  ReportKpiRow,
  ReportMark,
  ReportNote,
  ReportSection,
  ReportTable,
  ReportTitle,
  type ReportColumn,
} from "@/components/report/report-blocks";
import { ReportLineChart } from "@/components/report/report-charts";
import { ReportDocument, ReportPage, type ReportLayout } from "@/components/report/report-document";
import { formatInt, formatMonth, formatSekAxis } from "@/lib/format";
import { isWholeMonth, periodText } from "@/reports/text";
import type {
  InventoryLine,
  OwnerPayout,
  PartnerComparison,
  PartnerEvent,
  PartnerRow,
} from "@/reports";
import type { PartnerSnapshot } from "@/server/reports/snapshot";

import {
  SECTION_TAG,
  TITLE_TAG,
  datePeriod,
  dayLabel,
  delta,
  kronor,
  localDate,
  minusSek,
  monthLabel,
  monthName,
  pct,
  periodLabel,
  sek,
  sekValue,
  sentence,
  type HeadingLevel,
} from "./shared";

/** Rader i tabellerna per automat och titel. */
const MAX_ROWS = 14;

interface ResultLine {
  label: string;
  now: number | null;
  prev: number | null;
  lastYear: number | null;
  kind: "ore" | "minus" | "bp";
  strong?: boolean;
}

function resultLines(s: PartnerSnapshot): ResultLine[] {
  const r = s.report.result;
  const p = s.report.previousMonth;
  const y = s.report.sameMonthLastYear;
  return [
    {
      label: "Intäkt, alla order",
      now: r.totalRevenueOre,
      prev: p?.totalRevenueOre ?? null,
      lastYear: y?.totalRevenueOre ?? null,
      kind: "ore",
      strong: true,
    },
    {
      label: "varav med inköpspris",
      now: r.revenueOre,
      prev: p?.revenueOre ?? null,
      lastYear: y?.revenueOre ?? null,
      kind: "ore",
    },
    { label: "Inköp", now: r.costOre, prev: null, lastYear: null, kind: "minus" },
    { label: "Avgifter", now: r.feesOre, prev: null, lastYear: null, kind: "minus" },
    ...(r.vmbVatOre
      ? [
          {
            label: "VMB-moms",
            now: r.vmbVatOre,
            prev: null,
            lastYear: null,
            kind: "minus" as const,
          },
        ]
      : []),
    { label: "Provision", now: r.commissionOre, prev: null, lastYear: null, kind: "minus" },
    ...(r.rentOre !== 0
      ? [{ label: "Hyra", now: r.rentOre, prev: null, lastYear: null, kind: "minus" as const }]
      : []),
    {
      label: r.profitOre < 0 ? "Förlust" : "Vinst",
      now: r.profitOre,
      prev: p?.profitOre ?? null,
      lastYear: y?.profitOre ?? null,
      kind: "ore",
      strong: true,
    },
    {
      label: "Marginal",
      now: r.marginBp,
      prev: p?.marginBp ?? null,
      lastYear: y?.marginBp ?? null,
      kind: "bp",
    },
  ];
}

function cell(value: number | null, kind: ResultLine["kind"]) {
  if (value === null) return "–";
  if (kind === "bp") return pct(value);
  if (kind === "minus") return minusSek(value);
  return sek(value);
}

/** Kolumnrubriken för en jämförelse: "september", eller för eget datum "15–30 sep. 2026". */
function compareHeader(c: PartnerComparison, custom: boolean, withYear: boolean): string {
  if (custom && c.period) return periodText(c.period);
  return withYear ? monthLabel(c.month) : monthName(c.month);
}

function resultColumns(
  s: PartnerSnapshot,
  prev: PartnerComparison | null,
  lastYear: PartnerComparison | null,
): ReportColumn<ResultLine>[] {
  const custom = !isWholeMonth(s.period);
  return [
    {
      key: "label",
      header: "Post",
      width: "34%",
      render: (l) => <span className={l.strong ? "font-medium" : "text-muted"}>{l.label}</span>,
    },
    {
      key: "now",
      header: custom ? periodText(s.period) : monthName(s.month),
      numeric: true,
      render: (l) => cell(l.now, l.kind),
    },
    {
      key: "prev",
      header: prev
        ? compareHeader(prev, custom, false)
        : custom
          ? "Perioden före"
          : "Förra månaden",
      numeric: true,
      render: (l) => (prev ? cell(l.prev, l.kind) : "–"),
    },
    {
      key: "lastYear",
      header: lastYear ? compareHeader(lastYear, custom, true) : "I fjol",
      numeric: true,
      render: (l) => (lastYear ? cell(l.lastYear, l.kind) : "–"),
    },
  ];
}

function rowColumns(label: string): ReportColumn<PartnerRow>[] {
  return [
    {
      key: "name",
      header: label,
      width: "34%",
      render: (r) =>
        r.kind === "unallocated" ? (
          <span className="text-muted">Ej fördelad hyra</span>
        ) : r.kind === "no-machine" ? (
          <span className="text-muted">Ej kopplad automat</span>
        ) : (
          r.name
        ),
    },
    { key: "orders", header: "Order", numeric: true, render: (r) => formatInt(r.orders) },
    {
      key: "revenue",
      header: "Intäkt",
      numeric: true,
      render: (r) => sek(r.revenueOre + r.unpricedRevenueOre),
    },
    {
      key: "comp",
      header: "Ersättning",
      numeric: true,
      render: (r) => minusSek(r.compensationOre),
    },
    {
      key: "profit",
      header: "Vinst",
      numeric: true,
      render: (r) => sek(r.profitOre),
    },
    { key: "margin", header: "Marginal", numeric: true, render: (r) => pct(r.marginBp) },
  ];
}

const inventoryColumns: ReportColumn<InventoryLine>[] = [
  { key: "name", header: "Titel", width: "44%", render: (l) => l.name },
  { key: "qty", header: "Pack", numeric: true, render: (l) => formatInt(l.quantity) },
  {
    key: "unit",
    header: "Inköpspris",
    numeric: true,
    render: (l) => (l.unitCostOre === null ? "saknas" : kronor(l.unitCostOre)),
  },
  {
    key: "value",
    header: "Värde",
    numeric: true,
    render: (l) => (l.valueOre === null ? "–" : sek(l.valueOre)),
  },
];

const ownerColumns: ReportColumn<OwnerPayout>[] = [
  { key: "name", header: "Ägare", width: "50%", render: (o) => o.name },
  { key: "share", header: "Andel", numeric: true, render: (o) => pct(o.shareBp, 2) },
  { key: "amount", header: "Belopp", numeric: true, render: (o) => kronor(o.amountOre) },
];

const SEVERITY: Record<PartnerEvent["severity"], string> = {
  info: "Info",
  positive: "Positivt",
  warning: "Att åtgärda",
};

export function PartnerReportDocument({
  snapshot,
  layout = "stack",
  level = "page",
  recipient = "Delägarna",
}: {
  snapshot: PartnerSnapshot;
  layout?: ReportLayout;
  level?: HeadingLevel;
  recipient?: string;
}) {
  const r = snapshot.report;
  const res = r.result;
  const month = periodLabel(snapshot);
  const custom = !isWholeMonth(snapshot.period);
  // KPI-raden: "mot september", eller för eget datum "mot perioden före".
  const against = (c: PartnerComparison) =>
    custom ? "mot perioden före" : `mot ${monthName(c.month)}`;
  const prev = r.previousMonth;
  const lastYear = r.sameMonthLastYear;
  const months = r.trend.months;
  const withData = months.filter((m) => m.hasData);
  const machines = [...r.machines].sort((a, b) => b.profitOre - a.profitOre);
  const titles = [...r.titles]
    .sort((a, b) => b.revenueOre + b.unpricedRevenueOre - (a.revenueOre + a.unpricedRevenueOre))
    .slice(0, MAX_ROWS);
  const inventoryLines = r.inventory
    ? [...r.inventory.lines].sort((a, b) => (b.valueOre ?? -1) - (a.valueOre ?? -1)).slice(0, 10)
    : [];
  const warnings = r.events.filter((e) => e.severity === "warning");

  return (
    <ReportDocument
      title={`Delägarrapport ${month}`}
      recipient={recipient}
      sender={snapshot.organization.name}
      period={datePeriod(snapshot.period)}
      generatedAt={new Date(snapshot.generatedAt)}
      timeZone={snapshot.organization.timeZone}
      layout={layout}
    >
      <ReportPage className="gap-[8mm]">
        <ReportTitle
          as={TITLE_TAG[level]}
          eyebrow={`Delägarrapport · ${snapshot.organization.name}`}
          title={r.conclusion.text}
        >
          {snapshot.comment ? <p className="whitespace-pre-line">{snapshot.comment}</p> : null}
        </ReportTitle>

        <ReportKpiRow
          items={[
            {
              label: "Intäkt",
              value: sekValue(res.totalRevenueOre),
              unit: "kr",
              delta: delta(prev?.totalRevenueChangeBp ?? null),
              context: prev?.totalRevenueChangeBp != null ? against(prev) : undefined,
            },
            {
              label: res.profitOre < 0 ? "Förlust" : "Vinst",
              value: sekValue(res.profitOre),
              unit: "kr",
              delta: delta(prev?.profitChangeBp ?? null),
              context: prev?.profitChangeBp != null ? against(prev) : undefined,
              flag: res.profitOre < 0 ? "Under noll" : undefined,
            },
            {
              label: "Marginal",
              value: res.marginBp === null ? "–" : pct(res.marginBp).replace(/\s*%$/, ""),
              unit: res.marginBp === null ? undefined : "%",
            },
            {
              label: "Lagervärde",
              value: r.inventory ? sekValue(r.inventory.totalValueOre) : "–",
              unit: r.inventory ? "kr" : undefined,
              context: r.inventory ? `${formatInt(r.inventory.quantity)} pack` : "saknas",
            },
          ]}
        />

        <ReportSection
          as={SECTION_TAG[level]}
          index={1}
          eyebrow="Resultat"
          title={`${res.profitOre < 0 ? "Förlust" : "Vinst"} ${sek(res.profitOre)}.`}
          aside={
            [prev?.text, lastYear?.text].filter(Boolean).join(" ") ||
            "Ingen historik att jämföra med."
          }
        >
          <ReportTable
            caption={
              custom
                ? `Resultat för ${month} jämfört med lika många dagar före och samma period i fjol.`
                : `Resultat för ${month} jämfört med förra månaden och samma månad i fjol.`
            }
            columns={resultColumns(snapshot, prev, lastYear)}
            rows={resultLines(snapshot)}
            rowKey={(l) => l.label}
          />
          {res.unpricedOrders > 0 ? (
            <ReportNote>
              {formatInt(res.unpricedOrders)} order ({sek(res.unpricedRevenueOre)},{" "}
              {pct(res.unpricedShareBp)} av intäkten) saknar inköpspris och ingår inte i vinsten.
              {res.rentOre !== 0 ? " Hyran dras ändå i sin helhet." : null}
            </ReportNote>
          ) : null}
        </ReportSection>

        <ReportSection
          as={SECTION_TAG[level]}
          index={2}
          eyebrow={`Utveckling · ${formatInt(months.length)} månader`}
          title="Intäkt och vinst per månad."
          aside={`${
            r.trend.limitedHistory
              ? `Data finns för ${formatInt(withData.length)} ${withData.length === 1 ? "månad" : "månader"}.`
              : `Snitt ${sek(Math.round(withData.reduce((a, m) => a + m.revenueOre, 0) / Math.max(1, withData.length)))} intäkt per månad.`
          }${
            // Eget datum som slutar mitt i en månad: sista punkten är bara en del av månaden.
            r.trend.lastMonthThrough
              ? ` Sista månaden till och med ${sentence(dayLabel(r.trend.lastMonthThrough))}`
              : ""
          }`}
        >
          <ReportLineChart
            labels={months.map((m) =>
              formatMonth(localDate(`${m.month}-01`), { year: "never" }).slice(0, 3),
            )}
            ticks={months.map((_, i) => i)}
            series={[
              {
                name: "Intäkt",
                values: months.map((m) => (m.hasData ? m.revenueOre / 100 : null)),
              },
              {
                name: "Vinst",
                values: months.map((m) => (m.hasData ? m.profitOre / 100 : null)),
                line: "dashed",
                marker: "none",
              },
            ]}
            formatAxis={formatSekAxis}
            height={custom ? 150 : 200}
            summary={`Intäkt och vinst per månad, ${months
              .filter((m) => m.hasData)
              .map(
                (m) =>
                  `${monthLabel(m.month)}: intäkt ${sek(m.revenueOre)}, vinst ${sek(m.profitOre)}`,
              )
              .join("; ")}.`}
          />
        </ReportSection>
      </ReportPage>

      <ReportPage className="gap-[8mm]">
        <ReportSection
          as={SECTION_TAG[level]}
          index={3}
          eyebrow="Per automat"
          title={
            machines[0] && machines[0].kind === "item"
              ? `${machines[0].name} gav mest: ${sek(machines[0].profitOre)}.`
              : "Lönsamhet per automat."
          }
          aside="Vinst efter inköp, avgifter och butiksersättning, för order med inköpspris."
        >
          <ReportTable
            caption="Lönsamhet per automat."
            columns={rowColumns("Automat")}
            rows={machines}
            rowKey={(row) => row.key}
            isMarked={(row) => row.kind === "item" && row.profitOre < 0}
          />
        </ReportSection>

        <ReportSection
          as={SECTION_TAG[level]}
          index={4}
          eyebrow="Per titel"
          title={titles[0] ? `${titles[0].name} störst.` : "Lönsamhet per titel."}
          aside={
            r.titles.length > MAX_ROWS
              ? `De ${MAX_ROWS} titlarna med högst intäkt av ${formatInt(r.titles.length)}.`
              : `${formatInt(r.titles.filter((t) => t.kind === "item").length)} titlar sålde.`
          }
        >
          <ReportTable
            caption="Lönsamhet per titel."
            columns={rowColumns("Titel")}
            rows={titles}
            rowKey={(row) => row.key}
          />
        </ReportSection>
      </ReportPage>

      <ReportPage className="gap-[8mm]">
        <ReportSection
          as={SECTION_TAG[level]}
          index={5}
          eyebrow="Lager"
          title={
            r.inventory
              ? sentence(
                  `Lagervärde ${sek(r.inventory.totalValueOre)} den ${dayLabel(r.inventory.asOf)}`,
                )
              : "Lagervärdet saknas."
          }
          aside={
            r.inventory
              ? `${formatInt(r.inventory.quantity)} pack${r.inventory.unpricedQuantity > 0 ? `, varav ${formatInt(r.inventory.unpricedQuantity)} utan inköpspris` : ""}${snapshot.unknownStock > 0 ? `; ${formatInt(snapshot.unknownStock)} saldon okända` : ""}.`
              : `Inga lagerhändelser fram till ${custom ? "periodens" : "månadens"} slut.`
          }
        >
          {inventoryLines.length > 0 ? (
            <ReportTable
              caption={`Lager vid ${custom ? "periodens" : "månadens"} slut, högst värde först.`}
              columns={inventoryColumns}
              rows={inventoryLines}
              rowKey={(l) => l.titleId}
            />
          ) : null}
        </ReportSection>

        <ReportSection
          as={SECTION_TAG[level]}
          index={6}
          eyebrow="Händelser"
          title={
            r.events.length === 0
              ? "Inga särskilda händelser."
              : `${formatInt(r.events.length)} ${r.events.length === 1 ? "händelse" : "händelser"}.`
          }
          aside={
            warnings.length > 0
              ? `${formatInt(warnings.length)} att åtgärda.`
              : r.events.length > 0
                ? "Inget att åtgärda."
                : undefined
          }
        >
          {r.events.length > 0 ? (
            <ol className="flex flex-col border-t border-line text-[11px] leading-[15px]">
              {r.events.slice(0, 12).map((e, i) => (
                <li
                  key={`${e.kind}-${e.date}-${i}`}
                  className="grid grid-cols-[18mm_22mm_1fr] items-baseline gap-[3mm] border-b border-line py-[1.6mm]"
                >
                  <span className="tnum font-mono text-[10px] text-subtle">{dayLabel(e.date)}</span>
                  <span className="label flex items-center gap-1 text-[8.5px] text-subtle">
                    {e.severity === "warning" ? <ReportMark /> : null}
                    {SEVERITY[e.severity]}
                  </span>
                  <span className="text-fg">{e.text}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </ReportSection>

        <ReportSection
          as={SECTION_TAG[level]}
          index={7}
          eyebrow="Vinstfördelning"
          title={r.profitSplit ? r.profitSplit.text : "Ägarandelar saknas."}
          aside={
            r.profitSplit
              ? "Avkortat till helt öre per ägare; resten går till den största andelen."
              : "Lägg in ägarandelarna under Inställningar så fördelas vinsten exakt på öret."
          }
        >
          {r.profitSplit ? (
            <ReportTable
              caption="Vinstfördelning enligt ägarandelar."
              columns={ownerColumns}
              rows={r.profitSplit.owners}
              rowKey={(o) => o.id}
            />
          ) : null}
        </ReportSection>

        <ReportNote className="mt-auto">
          Vinst = intäkt − inköp − avgifter − butiksersättning, för order med inköpspris.
          {snapshot.report.result.rentOre !== 0 ? " Hyran dras alltid i sin helhet." : null}{" "}
          Beräkningsversion {snapshot.calcVersion}.
        </ReportNote>
      </ReportPage>
    </ReportDocument>
  );
}
