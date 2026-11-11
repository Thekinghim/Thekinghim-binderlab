"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  DataTable,
  sortOrder,
  type Column,
  type SortKey,
  type SortSpec,
} from "@/components/ui/data-table";
import { Segmented } from "@/components/ui/segmented";
import { StatusTag } from "@/components/ui/status-tag";
import { downloadCsv, toCsv, type CsvColumn } from "@/lib/csv";
import { formatCsvNumber, formatInt, formatMarginBp, formatSek, MISSING, NBSP } from "@/lib/format";

import type { ProfitLine, ViewKey } from "../_lib/model";

export const VIEW_OPTIONS: ReadonlyArray<{ value: ViewKey; label: string }> = [
  { value: "title", label: "Titel" },
  { value: "machine", label: "Automat" },
  { value: "store", label: "Butik" },
];

export const VIEW_NOUN: Record<ViewKey, string> = {
  title: "titel",
  machine: "automat",
  store: "butik",
};

const kr = (ore: number) => formatSek(ore / 100);
const pct = (bp: number | null) => (bp === null ? MISSING : formatMarginBp(bp));

/** Raden har order men inga med inköpspris: vinst och marginal går inte att räkna. */
function onlyUnpriced(r: ProfitLine): boolean {
  return r.kind === "item" && r.orders > 0 && r.orders === r.unpricedOrders;
}

/** "1 såld" · "12 sålda": antal sålda (order) under namnet på telefonen. */
export function soldLabel(orders: number): string {
  return `${formatInt(orders)}${NBSP}${orders === 1 ? "såld" : "sålda"}`;
}

/**
 * Raden under namnet på telefonen (under md), där kolumnen Order är dold: hur många som
 * sålts. Från md står antalet i kolumnen Order i stället.
 */
function SoldLine({ orders }: { orders: number }) {
  return (
    <span data-sold className="tnum basis-full text-sm text-muted md:hidden">
      {soldLabel(orders)}
    </span>
  );
}

/** Under den här marginalen (15 %) skrivs raden i varningsfärg på telefonen. */
export const LOW_MARGIN_BP = 1_500;

/** Raden under vinsten på telefonen: "marginal 31,4 %", och om den är låg. null utan marginal. */
export function marginLine(bp: number | null): { text: string; low: boolean } | null {
  if (bp === null) return null;
  return { text: `marginal ${formatMarginBp(bp)}`, low: bp < LOW_MARGIN_BP };
}

/**
 * Vinsten med marginalen som en liten rad under på telefonen (under md), där kolumnen
 * Marginal är dold: grå, eller i varningsfärg med ordet "låg" under 15 %. Från md står
 * marginalen i sin egen kolumn.
 */
function ProfitCell({ profit, marginBp }: { profit: ReactNode; marginBp: number | null }) {
  const m = marginLine(marginBp);
  return (
    <span className="inline-flex flex-col items-end">
      <span>{profit}</span>
      {m ? (
        <span
          data-margin={m.low ? "low" : "ok"}
          className={cn(
            "tnum text-xs whitespace-nowrap md:hidden",
            m.low ? "text-signal-fg" : "text-muted",
          )}
        >
          {m.low ? `låg ${m.text}` : m.text}
        </span>
      ) : null}
    </span>
  );
}

function NameCell({ row, selected }: { row: ProfitLine; selected: boolean }) {
  if (row.kind !== "item") {
    return (
      <span className="flex min-w-0 flex-col py-1.5">
        <span className="text-muted">{row.name}</span>
        {row.kind === "unallocated" ? (
          <span className="text-xs text-subtle">Hyra utan prissatta order</span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
      <span className="flex min-w-0 items-baseline gap-2">
        {row.code ? <span className="meta shrink-0 text-subtle">{row.code}</span> : null}
        <span className={selected ? "min-w-0 font-medium text-fg" : "min-w-0 text-fg"}>
          {row.name}
        </span>
      </span>
      {selected ? <StatusTag status="neutral">Vald</StatusTag> : null}
      {row.priceHref ? (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusTag status="warning">
            {onlyUnpriced(row) ? "Saknar pris" : `${formatInt(row.unpricedOrders)} utan pris`}
          </StatusTag>
          <Link
            href={row.priceHref}
            className="rounded-xs text-sm whitespace-nowrap text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-fg max-md:tap max-md:inline-flex max-md:min-h-11 max-md:items-center"
          >
            Lägg in pris<span className="sr-only"> för {row.name}</span>
            <span aria-hidden>{`${NBSP}→`}</span>
          </Link>
        </span>
      ) : null}
      <SoldLine orders={row.orders} />
    </span>
  );
}

const collator = new Intl.Collator("sv-SE", { numeric: true, sensitivity: "base" });

function sortName(r: ProfitLine): string {
  return r.code ? `${r.code} ${r.name}` : r.name;
}

/**
 * Sorteringsvärden. De särskilda raderna (ej fördelad hyra, utan automat/butik) och
 * saknade värden ger NaN, som DataTable alltid lägger sist oavsett riktning. Namnen
 * sorteras som rang (svensk ordning) av samma skäl.
 */
function sortValues(rows: readonly ProfitLine[]) {
  const names = Array.from(new Set(rows.filter((r) => r.kind === "item").map(sortName))).sort(
    collator.compare,
  );
  const rank = new Map(names.map((n, i) => [n, i]));
  const item = (get: (r: ProfitLine) => number) => (r: ProfitLine) =>
    r.kind === "item" ? get(r) : Number.NaN;
  const priced = (get: (r: ProfitLine) => number) =>
    item((r) => (onlyUnpriced(r) ? Number.NaN : get(r)));
  return {
    name: item((r) => rank.get(sortName(r)) ?? Number.NaN),
    orders: item((r) => r.orders),
    revenue: priced((r) => r.revenueOre),
    cost: priced((r) => r.costOre),
    fees: priced((r) => r.feesOre),
    vmb: priced((r) => r.vmbVatOre),
    compensation: priced((r) => r.compensationOre),
    profit: priced((r) => r.profitOre),
    margin: item((r) => (r.marginBp === null ? Number.NaN : r.marginBp)),
    unpriced: item((r) => r.unpricedRevenueOre),
  } satisfies Record<string, (r: ProfitLine) => number>;
}

export const DEFAULT_SORT: readonly SortKey[] = [{ key: "profit", dir: "desc" }];

export function columnsFor(
  view: ViewKey,
  rows: readonly ProfitLine[],
  totals: ProfitLine,
  showUnpriced: boolean,
  selectedKey: string | null = null,
  /**
   * Butikernas andel är dragen från vinsten (vyknappen "Visa butikernas andel" eller vald
   * butik): kolumnen med andelen visas och vinsten heter "Vår del". Av: vinsten och
   * marginalen är före andelen, och andelen visas inte (inte heller i CSV-exporten).
   */
  showStoreShare = false,
  storeShareLabel = "Butikernas andel",
): Column<ProfitLine>[] {
  const labels = profitLabels(showStoreShare);
  const nameHeader = VIEW_OPTIONS.find((o) => o.value === view)?.label ?? "Namn";
  const sv = sortValues(rows);
  const cols: Column<ProfitLine>[] = [
    {
      key: "name",
      header: nameHeader,
      sortValue: sv.name,
      render: (r) => <NameCell row={r} selected={r.kind === "item" && r.key === selectedKey} />,
      footer: (
        <span className="flex flex-col">
          <span className="font-medium text-fg">Totalt</span>
          <SoldLine orders={totals.orders} />
        </span>
      ),
      hideable: false,
      className: "md:min-w-48",
    },
    {
      key: "orders",
      header: "Order",
      numeric: true,
      sortValue: sv.orders,
      render: (r) => formatInt(r.orders),
      footer: formatInt(totals.orders),
      hideOnMobile: true,
    },
    {
      key: "revenue",
      header: "Intäkt med pris",
      numeric: true,
      sortValue: sv.revenue,
      render: (r) => (onlyUnpriced(r) ? MISSING : kr(r.revenueOre)),
      footer: kr(totals.revenueOre),
      hideOnMobile: true,
    },
    {
      key: "cost",
      header: "Inköp",
      numeric: true,
      sortValue: sv.cost,
      render: (r) => (onlyUnpriced(r) ? MISSING : kr(r.costOre)),
      footer: kr(totals.costOre),
      hideOnMobile: true,
    },
    {
      key: "fees",
      header: "Avgifter",
      numeric: true,
      sortValue: sv.fees,
      render: (r) => (onlyUnpriced(r) ? MISSING : kr(r.feesOre)),
      footer: kr(totals.feesOre),
      hideOnMobile: true,
    },
    {
      key: "vmb",
      header: "VMB-moms",
      numeric: true,
      sortValue: sv.vmb,
      render: (r) => (onlyUnpriced(r) ? MISSING : kr(r.vmbVatOre)),
      footer: kr(totals.vmbVatOre),
      hideOnMobile: true,
    },
    {
      key: "compensation",
      header: storeShareLabel,
      numeric: true,
      sortValue: sv.compensation,
      render: (r) => (onlyUnpriced(r) ? MISSING : kr(r.compensationOre)),
      footer: kr(totals.compensationOre),
      hideOnMobile: true,
    },
    {
      key: "profit",
      header: labels.profit,
      numeric: true,
      sortValue: sv.profit,
      render: (r) =>
        onlyUnpriced(r) ? (
          MISSING
        ) : (
          <ProfitCell profit={kr(r.profitOre)} marginBp={r.kind === "item" ? r.marginBp : null} />
        ),
      footer: (
        <ProfitCell
          profit={<span className="font-medium text-fg">{kr(totals.profitOre)}</span>}
          marginBp={totals.marginBp}
        />
      ),
    },
    {
      key: "margin",
      header: labels.margin,
      numeric: true,
      sortValue: sv.margin,
      render: (r) => pct(r.marginBp),
      footer: pct(totals.marginBp),
      // Telefon: marginalen står under vinsten (ProfitCell), så raden ryms utan att svepa.
      hideOnMobile: true,
    },
  ];
  // Utan kortavgifter (0 kr på alla rader) tar kolumnen bara plats; CSV-exporten har den kvar.
  const hasFees = totals.feesOre !== 0 || rows.some((r) => r.feesOre !== 0);
  if (!hasFees)
    cols.splice(
      cols.findIndex((c) => c.key === "fees"),
      1,
    );
  // Utan VMB (eller ingen VMB-moms i perioden) visas inte kolumnen; CSV-exporten har den kvar.
  const hasVmb = totals.vmbVatOre !== 0 || rows.some((r) => r.vmbVatOre !== 0);
  if (!hasVmb)
    cols.splice(
      cols.findIndex((c) => c.key === "vmb"),
      1,
    );
  if (!showStoreShare)
    cols.splice(
      cols.findIndex((c) => c.key === "compensation"),
      1,
    );
  if (showUnpriced) {
    cols.push({
      key: "unpriced",
      header: "Utan inköpspris",
      numeric: true,
      sortValue: sv.unpriced,
      render: (r) => (r.unpricedRevenueOre === 0 ? MISSING : kr(r.unpricedRevenueOre)),
      footer: kr(totals.unpricedRevenueOre),
      hideOnMobile: true,
    });
  }
  return cols;
}

/** Raderna i tabellens ordning (samma sortering som DataTable). */
export function sortedLines(rows: readonly ProfitLine[], sort: readonly SortKey[]): ProfitLine[] {
  const sv = sortValues(rows) as Record<string, (r: ProfitLine) => number>;
  const specs: SortSpec<ProfitLine>[] = [];
  for (const s of sort) {
    const get = sv[s.key];
    if (get) specs.push({ get, dir: s.dir });
  }
  const order = sortOrder(rows, specs);
  return Array.from(order, (i) => rows[i] as ProfitLine);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Belopp i kronor med två decimaler ("79987,00", "-3,50"). */
const csvKr = (ore: number) => formatCsvNumber(ore / 100, 2);
const FORMULA_START = /^[=+\-@\t\r]/;
/** Text som kalkylprogrammet inte får tolka som formel (talen är redan text). */
const csvText = (s: string) => (FORMULA_START.test(s) ? `'${s}` : s);

/** Rubrikerna för vinst och marginal, före eller efter butikernas andel. */
export function profitLabels(showStoreShare: boolean): { profit: string; margin: string } {
  return showStoreShare
    ? { profit: "Vår del", margin: "Marginal efter andel" }
    : { profit: "Vår vinst", margin: "Vår marginal" };
}

/**
 * Kolumnerna i CSV-filen: belopp i kronor med ören, marginal i procent med två decimaler.
 * Samma regel som tabellen: utan butikernas andel är vinsten före andelen och kolumnen med
 * andelen saknas; med andelen finns den och vinsten är vår del efter den.
 */
function csvColumns(view: ViewKey, showStoreShare: boolean): CsvColumn<ProfitLine>[] {
  const nameHeader = VIEW_OPTIONS.find((o) => o.value === view)?.label ?? "Namn";
  const cols: CsvColumn<ProfitLine>[] = [{ header: nameHeader, csv: (r) => csvText(r.name) }];
  if (view === "machine") cols.push({ header: "Kod", csv: (r) => csvText(r.code ?? "") });
  cols.push(
    { header: "Order", csv: (r) => r.orders },
    { header: "Order med inköpspris", csv: (r) => r.orders - r.unpricedOrders },
    { header: "Order utan inköpspris", csv: (r) => r.unpricedOrders },
    { header: "Intäkt med inköpspris (kr)", csv: (r) => csvKr(r.revenueOre) },
    { header: "Inköp (kr)", csv: (r) => csvKr(r.costOre) },
    { header: "Avgifter (kr)", csv: (r) => csvKr(r.feesOre) },
    { header: "VMB-moms (kr)", csv: (r) => csvKr(r.vmbVatOre) },
    ...(showStoreShare
      ? [{ header: "Butikernas andel (kr)", csv: (r: ProfitLine) => csvKr(r.compensationOre) }]
      : []),
    {
      header: showStoreShare ? "Vår del (kr)" : "Vinst före butikernas andel (kr)",
      csv: (r) => csvKr(r.profitOre),
    },
    {
      header: showStoreShare ? "Marginal efter andel (%)" : "Marginal före butikernas andel (%)",
      csv: (r) => (r.marginBp === null ? null : formatCsvNumber(r.marginBp / 100, 2)),
    },
    { header: "Intäkt utan inköpspris (kr)", csv: (r) => csvKr(r.unpricedRevenueOre) },
  );
  return cols;
}

/**
 * Hela vyn som CSV i svenskt Excel-format, i tabellens ordning och med totalraden sist.
 * Talen skrivs som färdig text med två decimaler; formelskyddet görs på namnen här, så
 * att negativa belopp inte får en apostrof.
 */
export function lonsamhetCsv(
  view: ViewKey,
  rows: readonly ProfitLine[],
  totals: ProfitLine,
  sort: readonly SortKey[] = DEFAULT_SORT,
  showStoreShare = false,
) {
  return toCsv([...sortedLines(rows, sort), totals], csvColumns(view, showStoreShare), {
    escapeFormulas: false,
  });
}

export function ExportButton({
  view,
  rows,
  totals,
  sort,
  fileName,
  showStoreShare = false,
}: {
  view: ViewKey;
  rows: readonly ProfitLine[];
  totals: ProfitLine;
  sort: readonly SortKey[];
  fileName: string;
  showStoreShare?: boolean;
}) {
  return (
    <Button
      size="sm"
      iconLeft="download"
      // En CSV-fil går inte att öppna på telefonen; på mobilen tar knappen bara plats.
      className="max-md:hidden"
      onClick={() => downloadCsv(fileName, lonsamhetCsv(view, rows, totals, sort, showStoreShare))}
    >
      Exportera CSV
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Tabellen
// ---------------------------------------------------------------------------

export function ProfitTable({
  view,
  onViewChange,
  rows,
  totals,
  caption,
  sort,
  onSortChange,
  selectedKey,
  showStoreShare = false,
  storeShareLabel,
}: {
  view: ViewKey;
  onViewChange: (view: ViewKey) => void;
  rows: readonly ProfitLine[];
  totals: ProfitLine;
  caption: string;
  sort: readonly SortKey[];
  onSortChange: (sort: ReadonlyArray<SortKey>) => void;
  selectedKey: string | null;
  showStoreShare?: boolean;
  storeShareLabel?: string;
}) {
  const showUnpriced = totals.unpricedRevenueOre > 0;
  const columns = useMemo(
    () =>
      columnsFor(view, rows, totals, showUnpriced, selectedKey, showStoreShare, storeShareLabel),
    [view, rows, totals, showUnpriced, selectedKey, showStoreShare, storeShareLabel],
  );
  return (
    <DataTable
      key={view}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      caption={caption}
      defaultSort={sort}
      onSortChange={onSortChange}
      toolbar={
        <Segmented
          options={VIEW_OPTIONS}
          value={view}
          onChange={onViewChange}
          label="Visa lönsamhet per"
          size="sm"
        />
      }
    />
  );
}
