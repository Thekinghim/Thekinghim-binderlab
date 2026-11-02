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
  partial: "warning",
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
  const columns = useMemo<Column<TitleRow>[]>(() => {
    const statusOf = (r: TitleRow): Status =>
      TAG[r.status] === "critical" && !critical.has(r.id) ? "warning" : TAG[r.status];
    return [
      {
        key: "name",
        header: "Titel",
        // Namnet får inte tryckas ihop av de många beloppskolumnerna (bröts på tre rader).
        className: "md:min-w-48",
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
                href={`/inkopspriser?${q.toString()}`}
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
              {r.unpricedOrders > 0 && r.status !== "missing" ? (
                <span className="text-xs text-muted">
                  {formatInt(r.unpricedOrders)} order utan pris
                </span>
              ) : null}
              {/* Under md står statusen på egen rad under namnet, så att beloppet ryms (design.md 5.1). */}
              <span className="mt-1.5 md:hidden">
                <StatusTag status={statusOf(r)}>{STATUS_LABEL[r.status]}</StatusTag>
              </span>
            </span>
          );
        },
      },
      {
        key: "status",
        header: "Status",
        hideable: false,
        hideOnMobile: true,
        sortValue: (r) => STATUS_RANK[r.status],
        csv: (r) => STATUS_LABEL[r.status],
        render: (r) => <StatusTag status={statusOf(r)}>{STATUS_LABEL[r.status]}</StatusTag>,
      },
      {
        key: "cost",
        header: "Inköpspris",
        numeric: true,
        hideOnMobile: true,
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
              {/* Snittet i perioden bara när priset har ändrats under den (annars samma tal). */}
              {r.averageCostOre !== null && r.averageCostOre !== r.currentCostOre ? (
                <span className="meta text-subtle">snitt {money(r.averageCostOre)}</span>
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
        key: "avgCost",
        header: "Snitt inköp",
        numeric: true,
        hideOnMobile: true,
        // Samma som inköpspriset så länge priset inte ändrats i perioden; skillnaden står då
        // under inköpspriset. Kolumnen finns i kolumnvalet.
        defaultHidden: true,
        sortValue: (r) => r.averageCostOre ?? Number.NaN,
        csv: (r) => (r.averageCostOre === null ? "" : kr(r.averageCostOre)),
        render: (r) => money(r.averageCostOre),
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
        // Kvar efter hyra visas; hyran själv finns i kolumnvalet (så att status får plats).
        defaultHidden: true,
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
    ];
  }, [baseQuery, selectedId, today, critical]);

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
