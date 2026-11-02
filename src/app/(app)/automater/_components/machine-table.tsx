"use client";

import Link from "next/link";
import { useMemo } from "react";

import { wallClockIn } from "@/components/shell/period-state";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag } from "@/components/ui/status-tag";
import {
  formatDelta,
  formatInt,
  formatPercent,
  formatRelative,
  formatSek,
  MISSING,
  NBSP,
} from "@/lib/format";

import type { MachineListRow } from "../_lib/types";

function sek(ore: number): string {
  return formatSek(ore / 100);
}

function columns(timeZone: string, now: Date): Column<MachineListRow>[] {
  const localNow = wallClockIn(now, timeZone);
  return [
    {
      key: "machine",
      header: "Automat",
      sortValue: (r) => r.code,
      csv: (r) => `${r.code} ${r.name}`,
      hideable: false,
      render: (r) => (
        <Link
          href={r.href}
          className="flex min-w-0 flex-col rounded-xs py-1 hover:text-fg"
          aria-label={`${r.code} ${r.name}`}
        >
          <span className="meta text-fg">{r.code.replace("-", "‑")}</span>
          <span className="truncate text-sm text-muted">{r.name}</span>
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => (r.status.flagged ? 0 : r.status.status === "ok" ? 2 : 1),
      csv: (r) => r.status.label,
      hideable: false,
      render: (r) => (
        <span className="flex flex-col items-start gap-1">
          <StatusTag status={r.status.status}>{r.status.label}</StatusTag>
          {r.status.flagged ? (
            <span className="sr-only">Kräver åtgärd: {r.status.reason}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "store",
      header: "Butik",
      sortValue: (r) => r.storeName ?? "",
      csv: (r) => r.storeName ?? "",
      hideOnMobile: true,
      render: (r) =>
        r.storeName ? (
          <span className="text-sm text-muted">{r.storeName}</span>
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
      key: "profit",
      header: "Vinst",
      numeric: true,
      sortValue: (r) => r.profitOre,
      csv: (r) => r.profitOre / 100,
      render: (r) => sek(r.profitOre),
    },
    {
      key: "margin",
      header: "Marginal",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.marginBp ?? Number.NEGATIVE_INFINITY,
      csv: (r) => (r.marginBp === null ? "" : r.marginBp / 100),
      render: (r) => (r.marginBp === null ? MISSING : formatPercent(r.marginBp / 10_000, 1)),
    },
    {
      key: "share",
      header: "Andel",
      numeric: true,
      hideOnMobile: true,
      defaultHidden: true,
      sortValue: (r) => r.revenueShare,
      render: (r) => formatPercent(r.revenueShare, 0),
    },
    {
      key: "orders",
      header: "Order",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.orders,
      render: (r) => formatInt(r.orders),
    },
    {
      key: "top",
      header: "Mest såld",
      hideOnMobile: true,
      sortValue: (r) => r.topTitle?.name ?? "",
      csv: (r) => r.topTitle?.name ?? "",
      render: (r) =>
        r.topTitle ? (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm">{r.topTitle.name}</span>
            <span className="meta text-subtle">
              {formatInt(r.topTitle.orders)}
              {NBSP}st
            </span>
          </span>
        ) : (
          <span className="text-subtle">{MISSING}</span>
        ),
    },
    {
      key: "stock",
      header: "I lager",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.packsOnHand,
      render: (r) => `${formatInt(r.packsOnHand)}${NBSP}st`,
    },
    {
      key: "last",
      header: "Senaste order",
      hideOnMobile: true,
      sortValue: (r) => r.lastOrderAt ?? "",
      csv: (r) => r.lastOrderAt ?? "",
      render: (r) =>
        r.lastOrderAt ? (
          <span className="meta text-muted">
            {formatRelative(wallClockIn(new Date(r.lastOrderAt), timeZone), localNow).replace(
              /^igår/,
              "i går",
            )}
          </span>
        ) : (
          <span className="text-subtle">{MISSING}</span>
        ),
    },
  ];
}

/** Alla automater med periodens intäkt, vinst och status. */
export function MachineTable({
  rows,
  timeZone,
  now,
  caption,
}: {
  rows: readonly MachineListRow[];
  timeZone: string;
  now: string;
  caption: string;
}) {
  const cols = useMemo(() => columns(timeZone, new Date(now)), [timeZone, now]);
  return (
    <DataTable
      columns={cols}
      rows={rows}
      rowKey={(r) => r.id}
      caption={caption}
      columnPicker
      exportFileName="automater"
      toolbar
    />
  );
}
