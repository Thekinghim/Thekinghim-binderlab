"use client";

import Link from "next/link";
import { useMemo } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag } from "@/components/ui/status-tag";
import { formatDelta, formatSek, MISSING } from "@/lib/format";

import type { StoreRow } from "../_lib/types";

function sek(ore: number): string {
  return formatSek(ore / 100);
}

/** Id bryts aldrig: hårt bindestreck (U+2011). */
function code(c: string): string {
  return c.replace(/-/g, "‑");
}

function columns(monthLabel: string): Column<StoreRow>[] {
  return [
    {
      key: "store",
      header: "Butik",
      sortValue: (r) => r.name.toLocaleLowerCase("sv-SE"),
      csv: (r) => r.name,
      hideable: false,
      render: (r) => (
        <Link href={r.href} className="flex min-w-0 flex-col rounded-xs py-1 hover:text-fg">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-fg">{r.name}</span>
            {r.isExample ? <StatusTag status="neutral">Exempel</StatusTag> : null}
          </span>
          {r.place ? <span className="truncate text-sm text-muted">{r.place}</span> : null}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => (r.flag ? 0 : r.archived ? 2 : 1),
      csv: (r) => r.flag ?? (r.archived ? "Arkiverad" : "Avtal gäller"),
      hideable: false,
      render: (r) =>
        r.flag ? (
          <span className="flex flex-col items-start">
            <StatusTag status="critical">{r.flag}</StatusTag>
            <span className="sr-only">Kräver åtgärd: lägg in ett avtal för butiken.</span>
          </span>
        ) : r.archived ? (
          <StatusTag status="offline">Arkiverad</StatusTag>
        ) : r.current ? (
          <StatusTag status="ok">Avtal gäller</StatusTag>
        ) : (
          <StatusTag status="neutral">Inget avtal</StatusTag>
        ),
    },
    {
      key: "terms",
      header: "Ersättningsmodell",
      sortValue: (r) => r.current?.termsLabel ?? "",
      csv: (r) => r.current?.termsLabel ?? "",
      hideOnMobile: true,
      render: (r) =>
        r.current ? (
          <span className="text-sm text-muted">{r.current.termsLabel}</span>
        ) : (
          <span className="text-sm text-subtle">{MISSING}</span>
        ),
    },
    {
      key: "machines",
      header: "Automater",
      sortValue: (r) => r.machineCodes.length,
      csv: (r) => r.machineCodes.join(" "),
      hideOnMobile: true,
      render: (r) =>
        r.machineCodes.length > 0 ? (
          <span className="meta text-muted">{r.machineCodes.map(code).join(" · ")}</span>
        ) : (
          <span className="text-sm text-subtle">{MISSING}</span>
        ),
    },
    {
      key: "revenue",
      header: "Intäkt",
      numeric: true,
      sortValue: (r) => r.revenueOre,
      csv: (r) => r.revenueOre / 100,
      render: (r) => (
        <span className="flex flex-col items-end">
          <span>{sek(r.revenueOre)}</span>
          {r.revenueChange !== null ? (
            <span className="meta text-subtle">
              {formatDelta(r.revenueChange, Math.abs(r.revenueChange) < 0.1 ? 1 : 0)}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "compensation",
      header: "Ersättning",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.compensationOre,
      csv: (r) => r.compensationOre / 100,
      render: (r) => sek(r.compensationOre),
    },
    {
      key: "profit",
      header: "Vinst",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.profitOre,
      csv: (r) => r.profitOre / 100,
      render: (r) => sek(r.profitOre),
    },
    {
      key: "earned",
      header: `Intjänat ${monthLabel}`,
      numeric: true,
      sortValue: (r) => r.earnedMonthOre,
      csv: (r) => r.earnedMonthOre / 100,
      render: (r) => sek(r.earnedMonthOre),
    },
  ];
}

/** Butikerna med periodens intäkt och ersättning och vad de tjänat hittills i månaden. */
export function StoreTable({
  rows,
  caption,
  monthLabel,
}: {
  rows: readonly StoreRow[];
  caption: string;
  monthLabel: string;
}) {
  const cols = useMemo(() => columns(monthLabel), [monthLabel]);
  return (
    <DataTable
      columns={cols}
      rows={rows}
      rowKey={(r) => r.id}
      caption={caption}
      columnPicker
      exportFileName="butiker"
    />
  );
}
