/**
 * Bokföringsunderlaget som A4: sammanställning, avstämning mot Awish (ordernummer,
 * antal, luckor), per butik, per automat och per dag. Samma tal som Excel och SIE 4
 * (alla tre renderas ur samma ögonblicksbild).
 */

import {
  ReportFact,
  ReportKpiRow,
  ReportMark,
  ReportNote,
  ReportSection,
  ReportTable,
  ReportTitle,
  splitRows,
  type ReportColumn,
} from "@/components/report/report-blocks";
import { ReportDocument, ReportPage, type ReportLayout } from "@/components/report/report-document";
import { formatInt, formatPeriod, formatWeekdayDay } from "@/lib/format";
import {
  gapsText,
  type AccountantDay,
  type AccountantMachineRow,
  type AccountantStoreRow,
  type ReconciliationCheck,
} from "@/reports";
import type { AccountantSnapshot } from "@/server/reports/snapshot";

import {
  SECTION_TAG,
  TITLE_TAG,
  datePeriod,
  kronor,
  localDate,
  monthLabel,
  pct,
  sekValue,
  type HeadingLevel,
} from "./shared";

/** Rader per ark i dagstabellen. */
const DAY_ROWS_FIRST = 33;
const DAY_ROWS = 40;

function statement(s: AccountantSnapshot) {
  const t = s.report.totals;
  return [
    { label: "Försäljning inkl. moms", value: t.grossOre, strong: true },
    { label: `Utgående moms (${pct(s.report.vatRateBp, 0)})`, value: t.vatOre },
    { label: "Försäljning exkl. moms", value: t.netOre, strong: true },
    { label: `Kortavgifter (${pct(s.report.cardFeeBp)})`, value: t.feesOre },
    {
      label: `Inköpsvärde sålda pack (${formatInt(t.pricedOrders)} order med pris)`,
      value: t.costOre,
    },
    { label: "Provision till butiker", value: t.commissionOre },
    { label: "Hyra till butiker", value: t.rentOre },
    { label: "Butiksersättning totalt", value: t.compensationOre, strong: true },
  ];
}

type StatementRow = ReturnType<typeof statement>[number];

const statementColumns: ReportColumn<StatementRow>[] = [
  {
    key: "label",
    header: "Post",
    width: "70%",
    render: (r) => <span className={r.strong ? "font-medium" : undefined}>{r.label}</span>,
  },
  { key: "value", header: "Belopp", numeric: true, render: (r) => kronor(r.value) },
];

const checkColumns: ReportColumn<ReconciliationCheck>[] = [
  { key: "label", header: "Kontroll", width: "46%", render: (c) => c.label },
  {
    key: "expected",
    header: "Väntat",
    numeric: true,
    render: (c) => (c.unit === "ore" ? kronor(c.expected) : formatInt(c.expected)),
  },
  {
    key: "actual",
    header: "Summa",
    numeric: true,
    render: (c) => (c.unit === "ore" ? kronor(c.actual) : formatInt(c.actual)),
  },
  {
    key: "ok",
    header: "Status",
    numeric: true,
    render: (c) => (c.ok ? "Stämmer" : "! Avviker"),
  },
];

function storeColumns(s: AccountantSnapshot): ReportColumn<AccountantStoreRow>[] {
  const t = s.report.totals;
  return [
    { key: "name", header: "Butik", width: "30%", render: (r) => r.name, total: "Totalt" },
    {
      key: "orders",
      header: "Order",
      numeric: true,
      render: (r) => formatInt(r.orders),
      total: formatInt(t.orders),
    },
    {
      key: "gross",
      header: "Inkl. moms",
      numeric: true,
      render: (r) => kronor(r.grossOre),
      total: kronor(t.grossOre),
    },
    {
      key: "commission",
      header: "Provision",
      numeric: true,
      render: (r) => kronor(r.commissionOre),
      total: kronor(t.commissionOre),
    },
    {
      key: "rent",
      header: "Hyra",
      numeric: true,
      render: (r) => kronor(r.rentOre),
      total: kronor(t.rentOre),
    },
    {
      key: "comp",
      header: "Ersättning",
      numeric: true,
      render: (r) => kronor(r.compensationOre),
      total: kronor(t.compensationOre),
    },
  ];
}

function machineColumns(s: AccountantSnapshot): ReportColumn<AccountantMachineRow>[] {
  const t = s.report.totals;
  return [
    { key: "name", header: "Automat", width: "28%", render: (r) => r.name, total: "Totalt" },
    {
      key: "stores",
      header: "Butik",
      width: "24%",
      render: (r) => <span className="text-muted">{r.storeNames.join(", ") || "–"}</span>,
    },
    {
      key: "orders",
      header: "Order",
      numeric: true,
      render: (r) => formatInt(r.orders),
      total: formatInt(t.orders),
    },
    {
      key: "gross",
      header: "Inkl. moms",
      numeric: true,
      render: (r) => kronor(r.grossOre),
      total: kronor(t.grossOre),
    },
    {
      key: "net",
      header: "Exkl. moms",
      numeric: true,
      render: (r) => kronor(r.netOre),
      total: kronor(t.netOre),
    },
  ];
}

function dayColumns(s: AccountantSnapshot, last: boolean): ReportColumn<AccountantDay>[] {
  const t = s.report.totals;
  const total = <T,>(v: T) => (last ? v : undefined);
  return [
    {
      key: "date",
      header: "Dag",
      width: "22%",
      render: (d) => formatWeekdayDay(localDate(d.date)),
      total: total("Totalt"),
    },
    {
      key: "orders",
      header: "Order",
      numeric: true,
      render: (d) => formatInt(d.orders),
      total: total(formatInt(t.orders)),
    },
    {
      key: "gross",
      header: "Inkl. moms",
      numeric: true,
      render: (d) => kronor(d.grossOre),
      total: total(kronor(t.grossOre)),
    },
    {
      key: "vat",
      header: "Moms",
      numeric: true,
      render: (d) => kronor(d.vatOre),
      total: total(kronor(t.vatOre)),
    },
    {
      key: "net",
      header: "Exkl. moms",
      numeric: true,
      render: (d) => kronor(d.netOre),
      total: total(kronor(t.netOre)),
    },
    {
      key: "fees",
      header: "Avgifter",
      numeric: true,
      render: (d) => kronor(d.feesOre),
      total: total(kronor(t.feesOre)),
    },
  ];
}

export function AccountantReportDocument({
  snapshot,
  layout = "stack",
  level = "page",
  recipient = "Bokföringen",
}: {
  snapshot: AccountantSnapshot;
  layout?: ReportLayout;
  level?: HeadingLevel;
  recipient?: string;
}) {
  const r = snapshot.report;
  const t = r.totals;
  const rec = r.reconciliation;
  const month = monthLabel(snapshot.month);
  const n = rec.numbers;
  const dayPages = splitRows(r.days, DAY_ROWS, DAY_ROWS_FIRST);
  const failedChecks = rec.checks.filter((c) => !c.ok).length;

  return (
    <ReportDocument
      title={`Bokföringsunderlag ${month}`}
      recipient={recipient}
      sender={snapshot.organization.name}
      period={datePeriod(snapshot.period)}
      generatedAt={new Date(snapshot.generatedAt)}
      timeZone={snapshot.organization.timeZone}
      layout={layout}
      confidentiality={`Underlag för bokföringen · ${snapshot.organization.name}`}
    >
      <ReportPage className="gap-[8mm]">
        <ReportTitle
          as={TITLE_TAG[level]}
          eyebrow={`Bokföringsunderlag · ${snapshot.organization.name}`}
          title={r.conclusion.text}
        />

        <ReportKpiRow
          items={[
            { label: "Inkl. moms", value: sekValue(t.grossOre), unit: "kr" },
            { label: "Moms", value: sekValue(t.vatOre), unit: "kr", context: pct(r.vatRateBp, 0) },
            { label: "Butiksersättning", value: sekValue(t.compensationOre), unit: "kr" },
            {
              label: "Order",
              value: formatInt(t.orders),
              context:
                t.unpricedOrders > 0 ? `${formatInt(t.unpricedOrders)} utan inköpspris` : undefined,
              flag: rec.ok ? undefined : "Avstämningen avviker",
            },
          ]}
        />

        <ReportSection
          as={SECTION_TAG[level]}
          index={1}
          eyebrow="Sammanställning"
          title={`Försäljning ${kronor(t.grossOre)} inklusive moms.`}
          aside={`Butiksersättning ${kronor(t.compensationOre)}, inköpsvärde ${kronor(t.costOre)}.`}
        >
          <ReportTable
            caption={`Sammanställning för ${month}.`}
            columns={statementColumns}
            rows={statement(snapshot)}
            rowKey={(row) => row.label}
          />
          {t.unpricedOrders > 0 ? (
            <ReportNote>
              {formatInt(t.unpricedOrders)} order ({kronor(t.unpricedNetOre)} exkl. moms) saknar
              inköpspris: {r.unpricedTitles.map((u) => u.name).join(", ")}. Deras inköpsvärde ingår
              inte ovan.
            </ReportNote>
          ) : null}
        </ReportSection>

        <ReportSection
          as={SECTION_TAG[level]}
          index={2}
          eyebrow="Avstämning mot Awish"
          title={
            n
              ? `Ordernummer ${n.first}–${n.last}, ${formatInt(rec.orderCount)} order.`
              : `${formatInt(rec.orderCount)} order utan numeriska ordernummer.`
          }
          aside={
            n === null
              ? "Nummerserien kan inte stämmas av."
              : n.gaps.length === 0
                ? "Serien är komplett, inga luckor."
                : `${formatInt(n.missing)} nummer saknas: ${gapsText(n.gaps.slice(0, 8))}${n.gaps.length > 8 ? " m.fl." : ""}.`
          }
        >
          <div className="grid grid-cols-5 gap-[6mm] border-t border-line pt-[3mm]">
            <ReportFact label="Första">{n ? n.first : "–"}</ReportFact>
            <ReportFact label="Sista">{n ? n.last : "–"}</ReportFact>
            <ReportFact label="I intervallet">
              {n ? `${formatInt(n.count)} av ${formatInt(n.span)}` : "–"}
            </ReportFact>
            <ReportFact label="Utan titel">
              {snapshot.ordersWithoutTitle === undefined
                ? "–"
                : formatInt(snapshot.ordersWithoutTitle)}
            </ReportFact>
            <ReportFact label="Luckor">
              <span className="flex items-center gap-1.5">
                {n && n.gaps.length > 0 ? <ReportMark label="Kräver kontroll" /> : null}
                {n ? formatInt(n.gaps.length) : "–"}
              </span>
            </ReportFact>
          </div>
          <ReportTable
            caption="Kontrollsummor: varje summa räknad två vägar."
            columns={checkColumns}
            rows={rec.checks}
            rowKey={(c) => c.label}
            isMarked={(c) => !c.ok}
          />
          <ReportNote>
            {n && n.gaps.length > 0
              ? "En lucka kan vara en obetald order i Awish (bara betalda order importeras). Kontrollera numren i Awish orderlista. "
              : ""}
            {n && n.outsidePeriod.length > 0
              ? `${formatInt(n.outsidePeriod.length)} nummer i intervallet har affärsdatum utanför månaden och är inte luckor. `
              : ""}
            {rec.duplicateExternalIds.length > 0
              ? `Ordernummer som förekommer två gånger: ${rec.duplicateExternalIds.join(", ")}. `
              : ""}
            {(snapshot.ordersWithoutTitle ?? 0) > 0
              ? `${formatInt(snapshot.ordersWithoutTitle ?? 0)} order saknar kopplad titel. De ingår i försäljningen och butiksersättningen men saknar inköpspris; koppla titeln under Datakällor. `
              : ""}
            {failedChecks === 0
              ? "Alla kontrollsummor stämmer."
              : `${formatInt(failedChecks)} kontrollsumma avviker.`}
          </ReportNote>
        </ReportSection>
      </ReportPage>

      <ReportPage className="gap-[8mm]">
        <ReportSection
          as={SECTION_TAG[level]}
          index={3}
          eyebrow="Per butik"
          title={`Butiksersättning ${kronor(t.compensationOre)}.`}
          aside={`Provision ${kronor(t.commissionOre)} och hyra ${kronor(t.rentOre)}.`}
        >
          <ReportTable
            caption="Försäljning och butiksersättning per butik."
            columns={storeColumns(snapshot)}
            rows={r.stores}
            rowKey={(row) => row.storeId ?? row.kind}
          />
        </ReportSection>

        <ReportSection
          as={SECTION_TAG[level]}
          index={4}
          eyebrow="Per automat"
          title={`${formatInt(r.machines.filter((m) => m.kind === "machine").length)} automater sålde.`}
          aside={
            r.machines.some((m) => m.kind === "no-machine")
              ? "Order från automater som inte är kopplade står på egen rad."
              : "Alla order är kopplade till en automat."
          }
        >
          <ReportTable
            caption="Försäljning per automat."
            columns={machineColumns(snapshot)}
            rows={r.machines}
            rowKey={(row) => row.machineId ?? row.kind}
          />
        </ReportSection>

        <ReportSection
          as={SECTION_TAG[level]}
          index={5}
          eyebrow="Filer"
          title="Samma underlag som Excel och SIE 4."
          aside={
            snapshot.missingAccounts.length === 0
              ? `Verifikationsserie ${snapshot.sie.verificationSeries}, räkenskapsår ${formatPeriod(datePeriod(snapshot.sie.fiscalYear))}.`
              : `SIE saknar konton för ${snapshot.missingAccounts.join(", ")}.`
          }
        >
          <ReportNote>
            Excel: blad per dag, butik och automat samt avstämning. SIE 4: en verifikation per dag
            (avräkning mot försäljning och moms), butiksersättning per butik och inköpsvärde den
            sista dagen. Beräkningsversion {snapshot.calcVersion}.
          </ReportNote>
        </ReportSection>
      </ReportPage>

      {dayPages.map((rows, i) => (
        <ReportPage key={`days-${i}`} className="gap-[6mm]">
          {i === 0 ? (
            <ReportSection
              as={SECTION_TAG[level]}
              index={6}
              eyebrow="Per dag"
              title={`${formatInt(r.days.filter((d) => d.orders > 0).length)} dagar med försäljning.`}
              aside="Dagskassa per affärsdag (svensk tid), samma som verifikationerna i SIE."
            />
          ) : null}
          <ReportTable
            caption="Försäljning per dag."
            columns={dayColumns(snapshot, i === dayPages.length - 1)}
            rows={rows}
            rowKey={(d) => d.date}
            continued={i > 0}
          />
        </ReportPage>
      ))}
    </ReportDocument>
  );
}
