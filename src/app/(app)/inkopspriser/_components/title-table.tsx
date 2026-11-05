"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { MISSING, formatInt, formatKronor } from "@/lib/format";

import {
  PRICE_EDITOR_ID,
  STATUS_RANK,
  formatDayShort,
  kr,
  marginText,
  sentence,
  statusLabel,
  type TitleRow,
  type TitleStatus,
} from "../_lib/model";
import { revealEditor } from "./scroll-into-view";

const TAG: Record<TitleStatus, Status> = {
  missing: "critical",
  loss: "critical",
  partial: "warning",
  "loss-after-rent": "warning",
  idle: "neutral",
  ok: "ok",
};

function titleHref(baseQuery: string, id: string): string {
  const q = new URLSearchParams(baseQuery);
  q.set("titel", id);
  return `/inkopspriser?${q.toString()}`;
}

function money(ore: number | null): string {
  return ore === null ? MISSING : formatKronor(kr(ore));
}

/** Butikens andel som kolumner: rubriken och vem den gäller (vald butik eller alla). */
export interface StoreShareColumns {
  /** "Butikens andel" (en butik) eller "Butikernas andel". */
  readonly header: string;
  /** Vem andelen gäller, t.ex. "Sega gubben" eller "alla butiker" (tabellens beskrivning). */
  readonly scope: string;
}

/**
 * Tabellen över alla titlar: inköpspris, snittpris, vad som blir kvar och status.
 *
 * "Kvar per order" och "Kvar av pris" är hela beloppet, före butikens andel (ägarens regel:
 * hela beloppet som standard). Med `share` (vald butik eller "Visa butikernas andel") visas
 * också butikens andel och vår del per order. Statusen räknas på vår del (se statusLabel).
 */
export function TitleTable({
  rows,
  selectedId,
  baseQuery,
  today,
  periodLabel,
  criticalIds,
  rent = true,
  share = null,
  note,
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
  /**
   * Något avtal har hyra: kolumnerna "Hyra per order" och "Kvar efter hyra" visas. Utan
   * hyra är "Kvar per order" allt som blir kvar, och kolumnerna döljs.
   */
  rent?: boolean;
  /** Visa butikens andel och vår del (null = dolda, standard). */
  share?: StoreShareColumns | null;
  /** Extra mening i tabellens beskrivning (t.ex. att kvar per order är före andelen). */
  note?: string;
}) {
  const router = useRouter();
  const criticalKey = criticalIds.join(",");
  const critical = useMemo(() => new Set(criticalKey.split(",").filter(Boolean)), [criticalKey]);
  const columns = useMemo<Column<TitleRow>[]>(() => {
    const statusOf = (r: TitleRow): Status =>
      TAG[r.status] === "critical" && !critical.has(r.id) ? "warning" : TAG[r.status];
    const rentColumns: Column<TitleRow>[] = [
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
      // Samma grund som kolumnen bredvid: hela beloppet utan andel, vår del med andel.
      share
        ? {
            key: "afterRent",
            header: "Vår del efter hyra",
            numeric: true,
            hideOnMobile: true,
            // Med andelens två kolumner blir tabellen för bred: finns i kolumnvalet.
            defaultHidden: true,
            sortValue: (r) => r.leftAfterRentOre ?? Number.NaN,
            csv: (r) => (r.leftAfterRentOre === null ? "" : kr(r.leftAfterRentOre)),
            render: (r) => money(r.leftAfterRentOre),
          }
        : {
            key: "afterRent",
            header: "Kvar efter hyra",
            numeric: true,
            hideOnMobile: true,
            sortValue: (r) => r.leftBeforeAfterRentOre ?? Number.NaN,
            csv: (r) => (r.leftBeforeAfterRentOre === null ? "" : kr(r.leftBeforeAfterRentOre)),
            render: (r) => money(r.leftBeforeAfterRentOre),
          },
    ];
    const shareColumns: Column<TitleRow>[] = share
      ? [
          {
            key: "storeShare",
            header: share.header,
            numeric: true,
            hideOnMobile: true,
            sortValue: (r) => r.storeShareOre ?? Number.NaN,
            csv: (r) => (r.storeShareOre === null ? "" : kr(r.storeShareOre)),
            render: (r) => money(r.storeShareOre),
          },
          {
            key: "ours",
            header: "Vår del",
            numeric: true,
            sortValue: (r) => r.leftOre ?? Number.NaN,
            csv: (r) => (r.leftOre === null ? "" : kr(r.leftOre)),
            render: (r) => money(r.leftOre),
          },
        ]
      : [];
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
          return (
            <span className="flex min-w-0 flex-col">
              <Link
                href={titleHref(baseQuery, r.id)}
                scroll={false}
                onClick={(e) => {
                  // Redan vald: adressen ändras inte, så visa redigeraren direkt.
                  if (!selected || e.metaKey || e.ctrlKey || e.shiftKey) return;
                  e.preventDefault();
                  revealEditor(PRICE_EDITOR_ID);
                }}
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "rounded-xs underline-offset-4 hover:underline",
                  selected ? "font-medium text-fg underline" : "text-fg",
                )}
              >
                {r.name}
              </Link>
              {r.own || r.series || r.archived ? (
                <span className="text-xs text-subtle">
                  {[r.own ? "Egen produkt" : null, r.series, r.archived ? "Arkiverad" : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
              {r.unpricedOrders > 0 && r.status !== "missing" ? (
                <span className="text-xs text-muted">
                  {formatInt(r.unpricedOrders)} order utan pris
                </span>
              ) : null}
              {/* Under md står statusen på egen rad under namnet, så att beloppet ryms (design.md 5.1). */}
              <span className="mt-1.5 md:hidden">
                <StatusTag status={statusOf(r)}>{statusLabel(r)}</StatusTag>
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
        csv: (r) => statusLabel(r),
        render: (r) => <StatusTag status={statusOf(r)}>{statusLabel(r)}</StatusTag>,
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
        sortValue: (r) => r.leftBeforeOre ?? Number.NaN,
        csv: (r) => (r.leftBeforeOre === null ? "" : kr(r.leftBeforeOre)),
        render: (r) => money(r.leftBeforeOre),
      },
      {
        key: "margin",
        header: "Kvar av pris",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.marginBeforeBp ?? Number.NaN,
        csv: (r) => (r.marginBeforeBp === null ? "" : r.marginBeforeBp / 10_000),
        render: (r) => marginText(r),
      },
      ...shareColumns,
      ...(rent ? rentColumns : []),
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
  }, [baseQuery, selectedId, today, critical, rent, share]);

  // Klick var som helst på raden öppnar titelns prisredigerare (namnet är länken för tangentbordet).
  const openRow = useCallback(
    (r: TitleRow) => {
      if (r.id === selectedId) revealEditor(PRICE_EDITOR_ID);
      else router.push(titleHref(baseQuery, r.id), { scroll: false });
    },
    [router, baseQuery, selectedId],
  );

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      caption={[
        sentence(`Inköpspris och kvar per order per titel, ${periodLabel}`),
        share
          ? `Kvar per order är före andelen. ${share.header} och vår del: ${share.scope}.`
          : note,
      ]
        .filter(Boolean)
        .join(" ")}
      defaultSort={[
        { key: "status", dir: "asc" },
        { key: "orders", dir: "desc" },
      ]}
      exportFileName="inkopspriser"
      columnPicker
      toolbar
      onRowClick={openRow}
    />
  );
}
