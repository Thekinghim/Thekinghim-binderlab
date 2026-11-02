import {
  ReportDocument,
  ReportPage,
  type ReportLayout,
  type ReportTone,
} from "@/components/report/report-document";
import {
  ReportFact,
  ReportKpiRow,
  ReportMark,
  ReportNote,
  ReportSection,
  ReportTable,
  ReportTitle,
  type ReportColumn,
} from "@/components/report/report-blocks";
import {
  ReportBarChart,
  ReportLineChart,
  ReportShareBar,
  ReportTimeline,
} from "@/components/report/report-charts";
import {
  formatDate,
  formatDay,
  formatDecimal,
  formatDelta,
  formatDuration,
  formatInt,
  formatMonth,
  formatPercent,
  formatSek,
  formatSekAxis,
  formatTime,
  formatWeekdayDay,
} from "@/lib/format";
import {
  OPEN_HOURS,
  RENT_SHARE,
  availability,
  bestDay,
  days,
  incidents,
  machine,
  outageMinutes,
  products,
  refills,
  rent,
  reportMeta,
  revenueByDay,
  revenueByDayPrev,
  revenueExVat,
  seriesShare,
  totals,
  weekdayAverages,
  type Incident,
  type ProductRow,
  type Refill,
} from "./data";

const NO_YEAR = { year: "never" } as const;

/** Avslutar en mening utan att dubblera punkten efter en förkortning ("27 okt."). */
function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

// ---------------------------------------------------------------------------
// Härledda värden
// ---------------------------------------------------------------------------

const best = days[bestDay];
const bestValue = revenueByDay[bestDay] ?? 0;
const release = products.find((p) => p.id === "p1");
const releaseShare = release ? release.revenue / totals.revenue : 0;
const releaseDays = 31 - 24 + 1;

const weekendShare =
  days.reduce(
    (s, d, i) => s + ([0, 5, 6].includes(d.date.getDay()) ? (revenueByDay[i] ?? 0) : 0),
    0,
  ) / totals.revenue;
const weekendDays = days.filter((d) => [0, 5, 6].includes(d.date.getDay())).length;

const share = seriesShare();
const leader = share[0];
const pokemonWithoutRelease =
  products
    .filter((p) => p.series === "Pokémon" && p.id !== "p1")
    .reduce((s, p) => s + p.revenue, 0) /
    products.filter((p) => p.series === "Pokémon").reduce((s, p) => s + p.revenuePrev, 0) -
  1;

const weekdays = weekdayAverages();
const strongest = weekdays.reduce((b, d, i) => (d.value > (weekdays[b]?.value ?? 0) ? i : b), 0);
const midweek = weekdays.slice(0, 4);
const midweekAvg = midweek.reduce((s, d) => s + d.value, 0) / midweek.length;

const emptySlot = incidents.find((i) => !i.outage);
const refillPacks = refills.reduce((s, r) => s + r.packs, 0);
const lowest = refills.reduce<Refill | undefined>(
  (lo, r) => (!lo || r.before < lo.before ? r : lo),
  undefined,
);

/** Längsta tiden från start till åtgärd. */
const slowest = Math.max(...incidents.map((i) => i.end.getTime() - i.start.getTime()));

// ---------------------------------------------------------------------------
// Tabeller
// ---------------------------------------------------------------------------

const productColumns: ReportColumn<ProductRow>[] = [
  {
    key: "product",
    header: "Produkt",
    width: "29%",
    render: (p) => p.product,
    total: "Totalt",
  },
  { key: "series", header: "Serie", width: "21%", render: (p) => p.series },
  { key: "price", header: "Pris", numeric: true, render: (p) => formatSek(p.price) },
  {
    key: "units",
    header: "Sålda",
    numeric: true,
    render: (p) => formatInt(p.units),
    total: formatInt(totals.units),
  },
  {
    key: "revenue",
    header: "Intäkt",
    numeric: true,
    render: (p) => formatSek(p.revenue),
    total: formatSek(totals.revenue),
  },
  {
    key: "share",
    header: "Andel",
    numeric: true,
    render: (p) => formatPercent(p.revenue / totals.revenue),
    total: formatPercent(1),
  },
  {
    key: "delta",
    header: "Mot sep.",
    numeric: true,
    render: (p) => (p.revenuePrev === 0 ? "ny" : formatDelta(p.revenue / p.revenuePrev - 1)),
    total: formatDelta(totals.revenue / totals.revenuePrev - 1),
  },
];

const incidentColumns: ReportColumn<Incident>[] = [
  {
    key: "id",
    header: "Nr",
    width: "7%",
    render: (i) => (
      <span className="tnum inline-grid size-[3.4mm] place-items-center border border-fg align-[-0.5mm] font-mono text-[8px] leading-none">
        {i.id}
      </span>
    ),
  },
  {
    key: "start",
    header: "Start",
    width: "15%",
    render: (i) => (
      <span className="tnum font-mono text-[10.5px]">
        {formatDate(i.start, NO_YEAR)} {formatTime(i.start)}
      </span>
    ),
  },
  { key: "event", header: "Händelse", width: "32%", render: (i) => i.event },
  {
    key: "duration",
    header: "Varaktighet",
    numeric: true,
    width: "13%",
    render: (i) => formatDuration(i.end.getTime() - i.start.getTime()),
  },
  {
    key: "action",
    header: "Åtgärd",
    render: (i) => <span className="text-muted">{i.action}</span>,
  },
];

const refillColumns: ReportColumn<Refill>[] = [
  {
    key: "date",
    header: "Datum",
    width: "18%",
    render: (r) => formatDate(r.date, NO_YEAR),
    total: "Totalt",
  },
  {
    key: "time",
    header: "Klockan",
    numeric: true,
    width: "12%",
    render: (r) => formatTime(r.date),
  },
  {
    key: "kind",
    header: "Typ",
    width: "26%",
    render: (r) => (r.extra ? `Extra · avvikelse ${emptySlot?.id ?? ""}` : "Ordinarie"),
  },
  {
    key: "packs",
    header: "Påfyllda pack",
    numeric: true,
    render: (r) => formatInt(r.packs),
    total: formatInt(refillPacks),
  },
  {
    key: "before",
    header: "Fyllnad före",
    numeric: true,
    render: (r) => formatPercent(r.before, 0),
  },
  {
    key: "after",
    header: "Efter",
    numeric: true,
    render: (r) => formatPercent(r.after, 0),
  },
];

// ---------------------------------------------------------------------------
// Sidor
// ---------------------------------------------------------------------------

/** Diagrammet från sida 1, exporterat för gråskalebeviset på /design. */
export function RevenueChart() {
  return (
    <ReportLineChart
      labels={days.map((d) => formatDay(d.date))}
      ticks={[0, 4, 9, 14, 19, 24, 30]}
      series={[
        { name: "Okt.", values: revenueByDay },
        { name: "Sep.", values: [...revenueByDayPrev, null] },
      ]}
      formatAxis={formatSekAxis}
      highlight={
        best
          ? {
              index: bestDay,
              label: formatSek(bestValue),
              sub: `${formatWeekdayDay(best.date)} · släpp`,
            }
          : undefined
      }
      summary={`Intäkt per dag i oktober 2026 jämfört med september. Bästa dagen var ${
        best ? formatWeekdayDay(best.date) : ""
      } med ${formatSek(bestValue)}.`}
    />
  );
}

function SummaryPage() {
  return (
    <ReportPage className="gap-[9mm]">
      <ReportTitle
        eyebrow={`${machine.id} · ${machine.placement}`}
        title={`${formatSek(totals.revenue)} i oktober.`}
        aside={`Automatens bästa månad sedan installationen ${formatDate(machine.installed)}.`}
      />

      <ReportKpiRow
        items={[
          {
            label: "Intäkt inkl. moms",
            value: formatInt(totals.revenue),
            unit: "kr",
            delta: formatDelta(totals.revenue / totals.revenuePrev - 1),
            context: "mot sep.",
          },
          {
            label: "Sålda pack",
            value: formatInt(totals.units),
            delta: formatDelta(totals.units / totals.unitsPrev - 1),
            context: "mot sep.",
          },
          {
            label: "Snittköp",
            value: formatInt(totals.revenue / totals.purchases),
            unit: "kr",
            delta: formatDelta(
              totals.revenue / totals.purchases / (totals.revenuePrev / totals.purchasesPrev) - 1,
            ),
            context: "mot sep.",
          },
          {
            label: "Omsättningshyra",
            value: formatInt(rent),
            unit: "kr",
            context: `${formatPercent(RENT_SHARE, 0)} exkl. moms`,
          },
        ]}
      />

      <ReportSection
        index={1}
        eyebrow="Försäljning"
        title="Intäkt per dag."
        aside={
          best
            ? `Släppet ${formatDate(best.date, NO_YEAR)} gav månadens bästa dag, ${formatSek(bestValue)}.`
            : undefined
        }
      >
        <RevenueChart />
      </ReportSection>

      <ReportSection
        index={2}
        eyebrow="Kommentar"
        title="Släppet och helgerna bar månaden."
        aside={`Fredag till söndag gav ${formatPercent(weekendShare, 0)} av intäkten på ${weekendDays} av 31 dagar.`}
      >
        <ol className="flex flex-col">
          {[
            `Släppet lördag 24 okt. sålde ${formatInt(release?.units ?? 0)} pack på ${releaseDays} dagar, ${formatPercent(releaseShare, 0)} av månadens intäkt.`,
            `Utan släppet hade Pokémon minskat ${formatPercent(Math.abs(pokemonWithoutRelease), 0)} mot september. One Piece växte ${formatDelta((share.find((s) => s.label === "One Piece")?.value ?? 0) / (share.find((s) => s.label === "One Piece")?.prev ?? 1) - 1)}.`,
            emptySlot
              ? `Fack 3 var tomt i ${formatDuration(emptySlot.end.getTime() - emptySlot.start.getTime())} den 29–30 okt. Från november fylls automaten på var tredje dag i stället för var fjärde.`
              : "",
          ].map((t, i) => (
            <li
              key={i}
              className="grid grid-cols-[7mm_1fr] items-baseline border-t border-line py-[2.4mm] text-[12px] leading-[17px] text-fg last:border-b"
            >
              <span className="tnum font-mono text-[9.5px] text-subtle">{i + 1}</span>
              <span>{t}</span>
            </li>
          ))}
        </ol>
      </ReportSection>

      <ReportNote className="mt-auto">
        Källa: Binderlab kassasystem och automatlogg för {machine.id}. Belopp inkl. 25 % moms om
        inget annat anges. Heldragen linje: oktober. Streckad: september, per dag i månaden.
        Omsättningshyra enligt avtal: {formatPercent(RENT_SHARE, 0)} av intäkt exkl. moms,{" "}
        {formatSek(revenueExVat)}. Snittköp: intäkt delad på {formatInt(totals.purchases)} köp.
      </ReportNote>
    </ReportPage>
  );
}

function AssortmentPage() {
  const sorted = [...products].sort((a, b) => b.revenue - a.revenue);
  return (
    <ReportPage className="gap-[9mm]">
      <ReportSection
        index={3}
        eyebrow="Sortiment"
        title={`${leader?.label ?? ""} stod för ${formatPercent((leader?.value ?? 0) / totals.revenue, 0)} av intäkten.`}
        aside={`Utan släppet 24 okt. hade serien minskat ${formatPercent(Math.abs(pokemonWithoutRelease), 0)} mot september.`}
      >
        <ReportShareBar
          segments={share.map((s) => ({
            label: s.label === "Magic: The Gathering" ? "Magic" : s.label,
            value: s.value,
            note: `${formatDelta(s.value / s.prev - 1)}`,
          }))}
          format={formatSek}
          summary="Andel av intäkten per serie i oktober 2026."
        />
        <ReportTable
          caption="Försäljning per produkt i oktober 2026 med förändring mot september"
          columns={productColumns}
          rows={sorted}
          rowKey={(p) => p.id}
          isMarked={(p) => p.id === "p1"}
        />
        <ReportNote className="flex items-center gap-[1.5mm]">
          <ReportMark />
          Markerad rad: släppet 24 okt., samma som markerad dag i diagram 01. Priser inkl. moms.
        </ReportNote>
      </ReportSection>

      <ReportSection
        index={4}
        eyebrow="Veckodagar"
        title={`${weekdays[strongest]?.label === "Lör" ? "Lördag" : (weekdays[strongest]?.label ?? "")} är starkast med ${formatSek(weekdays[strongest]?.value ?? 0)} i snitt.`}
        aside={`Måndag till torsdag ligger kring ${formatSek(Math.round(midweekAvg / 10) * 10)} per dag.`}
      >
        <ReportBarChart
          data={weekdays}
          format={formatSek}
          formatAxis={formatSekAxis}
          highlightIndex={strongest}
          summary="Snittintäkt per veckodag i oktober 2026."
        />
      </ReportSection>
    </ReportPage>
  );
}

function OperationsPage() {
  return (
    <ReportPage className="gap-[8mm]">
      <ReportSection
        index={5}
        eyebrow="Drift"
        title={`Tillgänglighet ${formatPercent(availability)} under centrumets öppettider.`}
        aside={`Alla ${incidents.length} avvikelser åtgärdades inom ett dygn, den längsta på ${formatDuration(slowest)}.`}
      >
        <ReportKpiRow
          items={[
            {
              label: "Tillgänglighet",
              value: formatDecimal(availability * 100),
              unit: "%",
              context: `${OPEN_HOURS.from}–${OPEN_HOURS.to} alla dagar`,
            },
            {
              label: "Driftstopp",
              value: formatDuration(outageMinutes * 60_000),
              context: `${incidents.filter((i) => i.outage).length} tillfällen`,
            },
            {
              label: "Avvikelser",
              value: formatInt(incidents.length),
              context: "alla åtgärdade",
            },
            {
              label: "Påfyllningar",
              value: formatInt(refills.length),
              context: `varav ${refills.filter((r) => r.extra).length} extra`,
            },
          ]}
        />
        <ReportTimeline
          start={reportMeta.period.start}
          days={31}
          events={incidents}
          dayLabel={(d) => (d === 0 ? "1 okt" : String(d + 1))}
          summary="Avvikelser i oktober 2026 på en tidslinje per dygn."
        />
        <ReportTable
          caption="Avvikelser i oktober 2026"
          columns={incidentColumns}
          rows={incidents}
          rowKey={(i) => i.id}
        />
      </ReportSection>

      <ReportSection
        index={6}
        eyebrow="Påfyllning"
        title={`${refills.length} påfyllningar, ${formatInt(refillPacks)} pack.`}
        aside={
          lowest
            ? sentence(
                `Lägst fyllnad före påfyllning var ${formatPercent(lowest.before, 0)} den ${formatDate(lowest.date, NO_YEAR)}`,
              )
            : undefined
        }
      >
        <ReportTable
          caption="Påfyllningar i oktober 2026"
          columns={refillColumns}
          rows={refills}
          rowKey={(r) => r.date.toISOString()}
        />
      </ReportSection>

      <div className="mt-auto grid grid-cols-3 gap-[6mm] border-t border-line-strong pt-[3mm]">
        <ReportFact label="Drift och påfyllning">
          drift@binderlab.se
          <br />
          070-174 06 42
          <br />
          <span className="text-muted">Vardagar 08–17, larm dygnet runt</span>
        </ReportFact>
        <ReportFact label="Avtal och omsättningshyra">
          avtal@binderlab.se
          <br />
          070-174 06 57
        </ReportFact>
        <ReportFact label="Nästa rapport">
          Månadsrapport {formatMonth(new Date(2026, 10, 1))}
          <br />
          <span className="text-muted">Skickas {formatDate(new Date(2026, 11, 2))}</span>
        </ReportFact>
      </div>
    </ReportPage>
  );
}

type ExampleReportProps = {
  layout?: ReportLayout;
  tone?: ReportTone;
  visiblePages?: ReadonlyArray<number>;
  className?: string;
};

/** "Månadsrapport oktober 2026" till Westfield Arninge. Tre A4-sidor. */
export function ExampleReport({ layout, tone, visiblePages, className }: ExampleReportProps) {
  return (
    <ReportDocument
      {...reportMeta}
      layout={layout}
      tone={tone}
      visiblePages={visiblePages}
      className={className}
    >
      <SummaryPage />
      <AssortmentPage />
      <OperationsPage />
    </ReportDocument>
  );
}

export const EXAMPLE_PAGE_COUNT = 3;
