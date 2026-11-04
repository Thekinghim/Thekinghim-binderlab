"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";

import { wallClockIn } from "@/components/shell/period-state";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusGlyph, StatusTag, type Status } from "@/components/ui/status-tag";

/** Status med pulserande ring när automaten är i drift. */
function MachineStatus({ status, label }: { status: Status; label: string }) {
  if (status !== "ok") return <StatusTag status={status}>{label}</StatusTag>;
  return (
    <span className="label inline-flex h-6 items-center gap-1.5 rounded-xs border border-transparent px-1.5 whitespace-nowrap text-muted">
      <span className="live-dot inline-flex w-2 justify-center rounded-full text-subtle">
        <StatusGlyph status="ok" size={6} />
      </span>
      {label}
    </span>
  );
}
import {
  formatDelta,
  formatInt,
  formatPercent,
  formatRelative,
  formatSek,
  MISSING,
  NBSP,
} from "@/lib/format";

import type { MachineListRow, MachinesOverview, OtherRow } from "../_lib/types";

function sek(ore: number): string {
  return formatSek(ore / 100);
}

/** Fotraden: en rad per post utanför automaterna och sist summan, i jämna rader. */
function Foot({ lines }: { lines: readonly ReactNode[] }) {
  return (
    <span className="flex flex-col py-1">
      {lines.map((l, i) => (
        <span key={i} className="block h-6 leading-6 whitespace-nowrap">
          {l}
        </span>
      ))}
    </span>
  );
}

interface FootData {
  readonly others: readonly OtherRow[];
  readonly totals: MachinesOverview["totals"];
}

/** Siffror som bara gäller när perioden har order (döljs medan dagens order inte kommit). */
const FIGURE_KEYS = new Set(["revenue", "profit", "margin", "share", "orders", "top"]);

function columns(
  timeZone: string,
  now: Date,
  foot: FootData | null,
  pending: boolean,
): Column<MachineListRow>[] {
  const localNow = wallClockIn(now, timeZone);
  const f = (
    pick: (o: OtherRow) => ReactNode,
    total: (t: MachinesOverview["totals"]) => ReactNode,
  ): ReactNode =>
    foot ? <Foot lines={[...foot.others.map(pick), total(foot.totals)]} /> : undefined;
  const cols: Column<MachineListRow>[] = [
    {
      key: "machine",
      header: "Automat",
      sortValue: (r) => r.code,
      csv: (r) => `${r.code} ${r.name}`,
      hideable: false,
      footer: f(
        (o) => o.label,
        () => "Totalt",
      ),
      render: (r) => (
        <span className="flex min-w-0 flex-col gap-1 py-1">
          <Link
            href={r.href}
            className="flex min-w-0 flex-col rounded-xs hover:text-fg"
            aria-label={`${r.code} ${r.name}`}
          >
            <span className="meta text-fg">{r.code.replace("-", "‑")}</span>
            <span className="truncate text-sm text-muted">{r.name}</span>
          </Link>
          {/* Under md står statusen här, under namnet (design.md 5.1). */}
          <span className="md:hidden">
            <MachineStatus status={r.status.status} label={r.status.label} />
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => (r.status.flagged ? 0 : r.status.status === "ok" ? 2 : 1),
      csv: (r) => r.status.label,
      hideable: false,
      hideOnMobile: true,
      render: (r) => (
        <span className="flex flex-col items-start gap-1">
          <MachineStatus status={r.status.status} label={r.status.label} />
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
      footer: f(
        (o) => (o.revenueOre !== 0 ? sek(o.revenueOre) : ""),
        (t) => sek(t.revenueOre),
      ),
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
      header: "Vår vinst",
      numeric: true,
      sortValue: (r) => r.profitOre,
      csv: (r) => r.profitOre / 100,
      footer: f(
        (o) => sek(o.profitOre),
        (t) => sek(t.profitOre),
      ),
      render: (r) => sek(r.profitOre),
    },
    {
      key: "margin",
      header: "Marginal",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.marginBp ?? Number.NEGATIVE_INFINITY,
      csv: (r) => (r.marginBp === null ? "" : r.marginBp / 100),
      footer: f(
        () => "",
        (t) => (t.marginBp === null ? MISSING : formatPercent(t.marginBp / 10_000, 1)),
      ),
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
      footer: f(
        (o) => (o.orders !== 0 ? formatInt(o.orders) : ""),
        (t) => formatInt(t.orders),
      ),
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
  return pending ? cols.filter((c) => !FIGURE_KEYS.has(c.key)) : cols;
}

/**
 * Alla automater med periodens intäkt, vinst och status. Fotraden visar ej fördelad hyra
 * (och order utan automat) och summan, så att raderna går ihop med nyckeltalen.
 */
export function MachineTable({
  rows,
  others,
  totals,
  pending = false,
  timeZone,
  now,
  caption,
}: {
  rows: readonly MachineListRow[];
  others: readonly OtherRow[];
  /** Summan i fotraden, eller null utan fotrad. */
  totals: MachinesOverview["totals"] | null;
  /** Dagens order har inte kommit: inga belopp. */
  pending?: boolean;
  timeZone: string;
  now: string;
  caption: string;
}) {
  const cols = useMemo(
    () => columns(timeZone, new Date(now), totals && !pending ? { others, totals } : null, pending),
    [timeZone, now, others, totals, pending],
  );
  return (
    <DataTable
      surface="bg"
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
