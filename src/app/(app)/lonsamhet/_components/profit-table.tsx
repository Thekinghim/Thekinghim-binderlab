"use client";

import Link from "next/link";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Segmented } from "@/components/ui/segmented";
import { StatusTag } from "@/components/ui/status-tag";
import { downloadCsv, toCsv, type CsvColumn } from "@/lib/csv";
import { formatInt, formatPercent, formatSek, MISSING, NBSP } from "@/lib/format";

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
const pct = (bp: number | null) => (bp === null ? MISSING : formatPercent(bp / 10_000));

/** Raden har order men inga med inköpspris: vinst och marginal går inte att räkna. */
function onlyUnpriced(r: ProfitLine): boolean {
  return r.kind === "item" && r.orders > 0 && r.orders === r.unpricedOrders;
}

function NameCell({ row }: { row: ProfitLine }) {
  if (row.kind !== "item") {
    return (
      <span className="flex min-w-0 flex-col py-1.5">
        <span className="text-muted">{row.name}</span>
        {row.kind === "unallocated" ? (
          <span className="meta text-subtle">Hyra som ingen order med inköpspris bär</span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
      <span className="flex min-w-0 items-baseline gap-2">
        {row.code ? <span className="meta shrink-0 text-subtle">{row.code}</span> : null}
        <span className="min-w-0 text-fg">{row.name}</span>
      </span>
      {row.priceHref ? (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusTag status="warning">
            {onlyUnpriced(row) ? "Saknar pris" : `${formatInt(row.unpricedOrders)} utan pris`}
          </StatusTag>
          <Link
            href={row.priceHref}
            className="rounded-xs text-sm whitespace-nowrap text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-fg"
          >
            Lägg in pris<span className="sr-only"> för {row.name}</span>
            <span aria-hidden>{`${NBSP}→`}</span>
          </Link>
        </span>
      ) : null}
    </span>
  );
}

function columnsFor(
  view: ViewKey,
  totals: ProfitLine,
  showUnpriced: boolean,
): Column<ProfitLine>[] {
  const nameHeader = VIEW_OPTIONS.find((o) => o.value === view)?.label ?? "Namn";
  const cols: Column<ProfitLine>[] = [
    {
      key: "name",
      header: nameHeader,
      sortValue: (r) => (r.code ? `${r.code} ${r.name}` : r.name),
      render: (r) => <NameCell row={r} />,
      footer: <span className="font-medium text-fg">Totalt</span>,
      hideable: false,
      className: "md:min-w-48",
    },
    {
      key: "orders",
      header: "Order",
      numeric: true,
      sortValue: (r) => r.orders,
      render: (r) => formatInt(r.orders),
      footer: formatInt(totals.orders),
      hideOnMobile: true,
    },
    {
      key: "revenue",
      header: "Intäkt",
      numeric: true,
      sortValue: (r) => r.revenueOre,
      render: (r) => (onlyUnpriced(r) ? MISSING : kr(r.revenueOre)),
      footer: kr(totals.revenueOre),
      hideOnMobile: true,
    },
    {
      key: "cost",
      header: "Inköp",
      numeric: true,
      sortValue: (r) => r.costOre,
      render: (r) => (onlyUnpriced(r) ? MISSING : kr(r.costOre)),
      footer: kr(totals.costOre),
      hideOnMobile: true,
    },
    {
      key: "fees",
      header: "Avgifter",
      numeric: true,
      sortValue: (r) => r.feesOre,
      render: (r) => (onlyUnpriced(r) ? MISSING : kr(r.feesOre)),
      footer: kr(totals.feesOre),
      hideOnMobile: true,
    },
    {
      key: "compensation",
      header: "Butiksersättning",
      numeric: true,
      sortValue: (r) => r.compensationOre,
      render: (r) => (onlyUnpriced(r) ? MISSING : kr(r.compensationOre)),
      footer: kr(totals.compensationOre),
      hideOnMobile: true,
    },
    {
      key: "profit",
      header: "Vinst",
      numeric: true,
      sortValue: (r) => r.profitOre,
      render: (r) => (onlyUnpriced(r) ? MISSING : kr(r.profitOre)),
      footer: <span className="font-medium text-fg">{kr(totals.profitOre)}</span>,
    },
    {
      key: "margin",
      header: "Marginal",
      numeric: true,
      sortValue: (r) => (r.marginBp === null ? Number.NaN : r.marginBp),
      render: (r) => pct(r.marginBp),
      footer: pct(totals.marginBp),
    },
  ];
  if (showUnpriced) {
    cols.push({
      key: "unpriced",
      header: "Utan inköpspris",
      numeric: true,
      sortValue: (r) => r.unpricedRevenueOre,
      render: (r) => (r.unpricedRevenueOre === 0 ? MISSING : kr(r.unpricedRevenueOre)),
      footer: kr(totals.unpricedRevenueOre),
      hideOnMobile: true,
    });
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const csvKr = (ore: number) => ore / 100;

/** Kolumnerna i CSV-filen: belopp i kronor med ören, marginal i procent. */
function csvColumns(view: ViewKey): CsvColumn<ProfitLine>[] {
  const nameHeader = VIEW_OPTIONS.find((o) => o.value === view)?.label ?? "Namn";
  const cols: CsvColumn<ProfitLine>[] = [{ header: nameHeader, csv: (r) => r.name }];
  if (view === "machine") cols.push({ header: "Kod", csv: (r) => r.code ?? "" });
  cols.push(
    { header: "Order", csv: (r) => r.orders },
    { header: "Order utan inköpspris", csv: (r) => r.unpricedOrders },
    { header: "Intäkt (kr)", csv: (r) => csvKr(r.revenueOre) },
    { header: "Inköp (kr)", csv: (r) => csvKr(r.costOre) },
    { header: "Avgifter (kr)", csv: (r) => csvKr(r.feesOre) },
    { header: "Butiksersättning (kr)", csv: (r) => csvKr(r.compensationOre) },
    { header: "Vinst (kr)", csv: (r) => csvKr(r.profitOre) },
    { header: "Marginal (%)", csv: (r) => (r.marginBp === null ? null : r.marginBp / 100) },
    { header: "Intäkt utan inköpspris (kr)", csv: (r) => csvKr(r.unpricedRevenueOre) },
  );
  return cols;
}

/** Hela vyn som CSV i svenskt Excel-format, störst vinst först och totalraden sist. */
export function lonsamhetCsv(view: ViewKey, rows: readonly ProfitLine[], totals: ProfitLine) {
  const sorted = [...rows].sort((a, b) => b.profitOre - a.profitOre);
  return toCsv([...sorted, totals], csvColumns(view));
}

export function ExportButton({
  view,
  rows,
  totals,
  fileName,
}: {
  view: ViewKey;
  rows: readonly ProfitLine[];
  totals: ProfitLine;
  fileName: string;
}) {
  return (
    <Button
      size="sm"
      iconLeft="download"
      onClick={() => downloadCsv(fileName, lonsamhetCsv(view, rows, totals))}
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
}: {
  view: ViewKey;
  onViewChange: (view: ViewKey) => void;
  rows: readonly ProfitLine[];
  totals: ProfitLine;
  caption: string;
}) {
  const showUnpriced = totals.unpricedRevenueOre > 0;
  const columns = useMemo(
    () => columnsFor(view, totals, showUnpriced),
    [view, totals, showUnpriced],
  );
  return (
    <DataTable
      key={view}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      caption={caption}
      defaultSort={{ key: "profit", dir: "desc" }}
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
