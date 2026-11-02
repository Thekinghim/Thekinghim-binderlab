"use client";

import { useMemo } from "react";

import { parseIsoDate, wallClockIn } from "@/components/shell/period-state";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag } from "@/components/ui/status-tag";
import {
  formatDate,
  formatDateTime,
  formatDecimal,
  formatInt,
  formatKronor,
  MISSING,
  NBSP,
} from "@/lib/format";

import type { PlacementLine, RecentOrder, StockLine } from "../_lib/types";

/** Betalsätt från Awish (samma översättning som på ordersidan). */
const PAYMENT: Record<string, string> = {
  card: "Kort",
  swish: "Swish",
  cash: "Kontant",
};

function paymentText(method: string | null): string {
  if (!method) return MISSING;
  return PAYMENT[method.trim().toLowerCase()] ?? method;
}

function day(iso: string | null, now: Date): string {
  const d = parseIsoDate(iso);
  return d ? formatDate(d, { year: "auto", now }) : MISSING;
}

function when(iso: string | null, timeZone: string, now: Date): string {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return MISSING;
  return formatDateTime(wallClockIn(d, timeZone), { now: wallClockIn(now, timeZone) });
}

// ---------------------------------------------------------------------------
// Lager
// ---------------------------------------------------------------------------

/** Automatens lager per titel: saldo, takt, hur länge det räcker och påfyllningsnivå. */
export function StockTable({
  lines,
  timeZone,
  now,
}: {
  lines: readonly StockLine[];
  timeZone: string;
  now: string;
}) {
  // Signalbudget: bara den mest brådskande titeln markeras; övriga "nu" får varningsform.
  const firstNow = lines.find((l) => l.level === "now")?.titleId ?? null;
  const cols = useMemo((): Column<StockLine>[] => {
    const n = new Date(now);
    const local = wallClockIn(n, timeZone);
    const status = (l: StockLine) =>
      l.level === "now" ? (
        <StatusTag status={l.titleId === firstNow ? "critical" : "warning"}>
          {l.onHand <= 0 ? "Slut" : "Fyll på nu"}
        </StatusTag>
      ) : l.level === "soon" ? (
        <StatusTag status="warning">Fyll på snart</StatusTag>
      ) : l.onHand <= 0 ? (
        <StatusTag status="offline">Slut</StatusTag>
      ) : (
        <StatusTag status="ok">Räcker</StatusTag>
      );
    return [
      {
        key: "title",
        header: "Titel",
        sortValue: (l) => l.name,
        hideable: false,
        render: (l) => (
          <span className="flex min-w-0 flex-col gap-1 py-1">
            <span className="text-sm">{l.name}</span>
            {/* Under md står statusen här, under namnet (design.md 5.1). */}
            <span className="md:hidden">{status(l)}</span>
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        hideOnMobile: true,
        sortValue: (l) => (l.level === "now" ? 0 : l.level === "soon" ? 1 : 2),
        render: (l) => status(l),
      },
      {
        key: "onHand",
        header: "I lager",
        numeric: true,
        sortValue: (l) => l.onHand,
        render: (l) => `${formatInt(l.onHand)}${NBSP}st`,
      },
      {
        key: "perDay",
        header: "Säljer per dag",
        numeric: true,
        hideOnMobile: true,
        sortValue: (l) => l.perDay ?? -1,
        render: (l) => (l.perDay === null ? MISSING : `${formatDecimal(l.perDay)}${NBSP}st`),
      },
      {
        key: "daysLeft",
        header: "Räcker",
        numeric: true,
        sortValue: (l) => l.daysLeft ?? Number.MAX_SAFE_INTEGER,
        render: (l) =>
          l.daysLeft === null
            ? MISSING
            : `${formatInt(l.daysLeft)}${NBSP}${l.daysLeft === 1 ? "dag" : "dagar"}`,
      },
      {
        key: "stockout",
        header: "Tar slut",
        hideOnMobile: true,
        sortValue: (l) => l.stockoutDate ?? "9999",
        render: (l) => <span className="meta text-muted">{day(l.stockoutDate, local)}</span>,
      },
      {
        key: "restocked",
        header: "Senast påfylld",
        hideOnMobile: true,
        sortValue: (l) => l.lastRestockedAt ?? "",
        render: (l) => (
          <span className="meta text-muted">{when(l.lastRestockedAt, timeZone, n)}</span>
        ),
      },
    ];
  }, [timeZone, now, firstNow]);
  return (
    <DataTable
      surface="bg"
      columns={cols}
      rows={lines}
      rowKey={(l) => l.titleId}
      caption="Lager i automaten per titel"
      dense
    />
  );
}

// ---------------------------------------------------------------------------
// Senaste order
// ---------------------------------------------------------------------------

/** De senaste orderna i automaten (oavsett period). */
export function RecentOrdersTable({
  orders,
  timeZone,
  now,
}: {
  orders: readonly RecentOrder[];
  timeZone: string;
  now: string;
}) {
  const cols = useMemo((): Column<RecentOrder>[] => {
    const n = new Date(now);
    return [
      {
        key: "at",
        header: "Tid",
        sortValue: (o) => o.orderedAt,
        hideable: false,
        render: (o) => <span className="meta text-muted">{when(o.orderedAt, timeZone, n)}</span>,
      },
      {
        key: "title",
        header: "Titel",
        sortValue: (o) => o.titleName,
        render: (o) => <span className="text-sm">{o.titleName}</span>,
      },
      {
        key: "amount",
        header: "Belopp",
        numeric: true,
        sortValue: (o) => o.amountOre,
        render: (o) => formatKronor(o.amountOre / 100),
      },
      {
        key: "payment",
        header: "Betalning",
        hideOnMobile: true,
        sortValue: (o) => o.paymentMethod ?? "",
        render: (o) => <span className="text-sm text-muted">{paymentText(o.paymentMethod)}</span>,
      },
      {
        key: "external",
        header: "Ordernummer",
        hideOnMobile: true,
        sortValue: (o) => o.externalId,
        render: (o) => <span className="meta text-subtle">{o.externalId}</span>,
      },
    ];
  }, [timeZone, now]);
  return (
    <DataTable
      surface="bg"
      columns={cols}
      rows={orders}
      rowKey={(o) => o.id}
      caption="Senaste order i automaten"
      defaultSort={{ key: "at", dir: "desc" }}
      dense
    />
  );
}

// ---------------------------------------------------------------------------
// Placeringar
// ---------------------------------------------------------------------------

/** Var automaten har stått, senaste först. */
export function PlacementsTable({
  placements,
  now,
}: {
  placements: readonly PlacementLine[];
  now: string;
}) {
  const cols = useMemo((): Column<PlacementLine>[] => {
    const n = new Date(now);
    return [
      {
        key: "store",
        header: "Butik",
        sortValue: (p) => p.storeName,
        hideable: false,
        render: (p) => (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{p.storeName}</span>
            {p.current ? <StatusTag status="neutral">Nu</StatusTag> : null}
          </span>
        ),
      },
      {
        key: "from",
        header: "Från",
        sortValue: (p) => p.from,
        render: (p) => <span className="meta text-muted">{day(p.from, n)}</span>,
      },
      {
        key: "to",
        header: "Till",
        sortValue: (p) => p.to ?? "9999",
        render: (p) => (
          <span className="meta text-muted">{p.to ? day(p.to, n) : "tills vidare"}</span>
        ),
      },
      {
        key: "days",
        header: "Dagar",
        numeric: true,
        sortValue: (p) => p.days,
        render: (p) => formatInt(p.days),
      },
    ];
  }, [now]);
  return (
    <DataTable
      surface="bg"
      columns={cols}
      rows={placements}
      rowKey={(p) => p.id}
      caption="Automatens placeringar"
      defaultSort={{ key: "from", dir: "desc" }}
      dense
    />
  );
}
