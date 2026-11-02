"use client";

import Link from "next/link";
import { useMemo } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { MISSING, formatInt, formatKronor, formatPercent } from "@/lib/format";

import {
  STATUS_LABEL,
  STATUS_RANK,
  formatDayShort,
  kr,
  type TitleRow,
  type TitleStatus,
} from "../_lib/model";

const TAG: Record<TitleStatus, Status> = {
  missing: "critical",
  loss: "critical",
  "loss-after-rent": "warning",
  idle: "neutral",
  ok: "ok",
};

function money(ore: number | null): string {
  return ore === null ? MISSING : formatKronor(kr(ore));
}

/** Tabellen över alla titlar: inköpspris, snittpris, vad som blir kvar och status. */
export function TitleTable({
  rows,
  selectedId,
  baseQuery,
  today,
  periodLabel,
  criticalIds,
}: {
  rows: readonly TitleRow[];
  selectedId: string | null;
  /** searchParams utan titel (period och filter följer med i länkarna). */
  baseQuery: string;
  today: string;
  periodLabel: string;
  /**
   * Rader som får signal (högst tre per vy enligt signalbudgeten). Övriga rader som kräver
   * åtgärd visas som varning med samma text.
   */
  criticalIds: readonly string[];
}) {
  const criticalKey = criticalIds.join(",");
  const critical = useMemo(() => new Set(criticalKey.split(",").filter(Boolean)), [criticalKey]);
  const columns = useMemo<Column<TitleRow>[]>(
    () => [
      {
        key: "name",
        header: "Titel",
        sortValue: (r) => r.name,
        csv: (r) => r.name,
        hideable: false,
        render: (r) => {
          const selected = r.id === selectedId;
          const q = new URLSearchParams(baseQuery);
          q.set("titel", r.id);
          return (
            <span className="flex min-w-0 flex-col">
              <Link
                href={`/inkopspriser?${q.toString()}#titel`}
                scroll={false}
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "rounded-xs underline-offset-4 hover:underline",
                  selected ? "font-medium text-fg underline" : "text-fg",
                )}
              >
                {r.name}
              </Link>
              {r.series || r.archived ? (
                <span className="text-xs text-subtle">
                  {[r.series, r.archived ? "Arkiverad" : null].filter(Boolean).join(" · ")}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        key: "cost",
        header: "Inköpspris",
        numeric: true,
        sortValue: (r) => r.currentCostOre ?? Number.NaN,
        csv: (r) => (r.currentCostOre === null ? "" : kr(r.currentCostOre)),
        render: (r) =>
          r.currentCostOre === null ? (
            MISSING
          ) : (
            <span className="flex flex-col items-end">
              <span>{money(r.currentCostOre)}</span>
              {r.currentFrom ? (
                <span className="meta text-subtle">
                  från {formatDayShort(r.currentFrom, today)}
                </span>
              ) : null}
            </span>
          ),
      },
      {
        key: "price",
        header: "Snittpris",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.averagePriceOre ?? Number.NaN,
        csv: (r) => (r.averagePriceOre === null ? "" : kr(r.averagePriceOre)),
        render: (r) => money(r.averagePriceOre),
      },
      {
        key: "left",
        header: "Kvar per order",
        numeric: true,
        sortValue: (r) => r.leftOre ?? Number.NaN,
        csv: (r) => (r.leftOre === null ? "" : kr(r.leftOre)),
        render: (r) => money(r.leftOre),
      },
      {
        key: "margin",
        header: "Kvar av pris",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.marginBp ?? Number.NaN,
        csv: (r) => (r.marginBp === null ? "" : r.marginBp / 10_000),
        render: (r) => (r.marginBp === null ? MISSING : formatPercent(r.marginBp / 10_000)),
      },
      {
        key: "rent",
        header: "Hyra per order",
        numeric: true,
        hideOnMobile: true,
        defaultHidden: false,
        sortValue: (r) => r.rentOre ?? Number.NaN,
        csv: (r) => (r.rentOre === null ? "" : kr(r.rentOre)),
        render: (r) => money(r.rentOre),
      },
      {
        key: "afterRent",
        header: "Kvar efter hyra",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.leftAfterRentOre ?? Number.NaN,
        csv: (r) => (r.leftAfterRentOre === null ? "" : kr(r.leftAfterRentOre)),
        render: (r) => money(r.leftAfterRentOre),
      },
      {
        key: "orders",
        header: "Order",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.orders,
        csv: (r) => r.orders,
        render: (r) => formatInt(r.orders),
      },
      {
        key: "status",
        header: "Status",
        hideable: false,
        sortValue: (r) => STATUS_RANK[r.status],
        csv: (r) => STATUS_LABEL[r.status],
        render: (r) => {
          const status =
            TAG[r.status] === "critical" && !critical.has(r.id) ? "warning" : TAG[r.status];
          return <StatusTag status={status}>{STATUS_LABEL[r.status]}</StatusTag>;
        },
      },
    ],
    [baseQuery, selectedId, today, critical],
  );

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      caption={`Inköpspris och kvar per order per titel, ${periodLabel}`}
      defaultSort={[
        { key: "status", dir: "asc" },
        { key: "orders", dir: "desc" },
      ]}
      exportFileName="inkopspriser"
      columnPicker
      toolbar
    />
  );
}
