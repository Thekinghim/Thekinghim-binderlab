"use client";

import Link from "next/link";
import { useMemo } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { ourProfitLabel } from "@/lib/store-share";
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

/** Statusens text utan åtgärd: kontraktet först (grönt = signerat). */
function quietStatus(r: StoreRow): string {
  if (r.archived) return "Arkiverad";
  if (r.contract === "signed") return "Signerat";
  return r.current ? "Villkor finns" : "Inga villkor";
}

/** Butikens status: åtgärd (röd, med text för skärmläsare), arkiverad eller kontraktet. */
function StoreStatus({ row: r }: { row: StoreRow }) {
  return r.issue ? (
    <span className="flex flex-col items-start">
      <StatusTag
        status={r.issue.level === "neutral" ? "warning" : r.issue.level}
        className={r.issue.level === "critical" ? "text-signal-fg" : undefined}
      >
        {r.issue.short}
      </StatusTag>
      <span className="sr-only">Kräver åtgärd: {r.issue.text}</span>
    </span>
  ) : r.archived ? (
    <StatusTag status="offline">Arkiverad</StatusTag>
  ) : r.contract === "signed" ? (
    <span className="label inline-flex h-6 items-center gap-1.5 text-up">
      <span aria-hidden className="size-1.5 rounded-full bg-up" />
      Signerat
    </span>
  ) : (
    <StatusTag status="neutral">{quietStatus(r)}</StatusTag>
  );
}

const SHORT_MONTH: Record<string, string> = {
  januari: "jan.",
  februari: "feb.",
  augusti: "aug.",
  september: "sep.",
  oktober: "okt.",
  november: "nov.",
  december: "dec.",
  april: "apr.",
};

/** "november" → "nov." (mars, maj, juni och juli står kvar). */
export function shortMonth(month: string): string {
  return SHORT_MONTH[month] ?? month;
}

function columns(monthLabel: string, showStoreShare: boolean): Column<StoreRow>[] {
  const all: Column<StoreRow>[] = [
    {
      key: "store",
      header: "Butik",
      sortValue: (r) => r.name.toLocaleLowerCase("sv-SE"),
      csv: (r) => r.name,
      hideable: false,
      render: (r) => (
        // max-w: platsen kortas med ellips i stället för att göra kolumnen bredare (hela
        // adressen står i title och på butikens sida).
        <Link
          href={r.href}
          className="flex max-w-56 min-w-0 flex-col rounded-xs py-1 hover:text-fg md:max-w-52"
        >
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-fg">{r.name}</span>
            {r.isExample ? <StatusTag status="neutral">Exempel</StatusTag> : null}
          </span>
          {r.place ? (
            <span className="truncate text-sm text-muted" title={r.place}>
              {r.place}
            </span>
          ) : null}
          <span className="mt-1 md:hidden">
            <StoreStatus row={r} />
          </span>
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) =>
        r.issue
          ? r.issue.level === "critical"
            ? 0
            : r.issue.level === "warning"
              ? 1
              : 2
          : r.archived
            ? 4
            : 3,
      csv: (r) => r.issue?.short ?? quietStatus(r),
      hideable: false,
      // Under md står statusen under namnet i första kolumnen (MachineCell på /design),
      // så att beloppen ryms utan sidledsscroll.
      hideOnMobile: true,
      render: (r) => <StoreStatus row={r} />,
    },
    {
      key: "terms",
      header: "Villkor",
      sortValue: (r) => r.current?.termsLabel ?? "",
      csv: (r) => r.current?.termsLabel ?? "",
      hideOnMobile: true,
      render: (r) =>
        r.current ? (
          <span className="block max-w-44 text-sm whitespace-normal text-muted">
            {r.current.termsLabel}
          </span>
        ) : (
          <span className="text-sm text-subtle">{MISSING}</span>
        ),
    },
    {
      key: "machines",
      header: "Automater",
      sortValue: (r) => r.machineCodes.length,
      csv: (r) => r.machineCodes.join(" "),
      // Bara från 1 400 px: under det ryms beloppen utan sidledsscroll. Koderna står
      // på butikens sida.
      className: "hidden min-[1400px]:table-cell",
      render: (r) =>
        // En kod per rad: kolumnen blir smal nog för att tabellen ska rymmas vid 1 440 px.
        r.machineCodes.length > 0 ? (
          <span className="meta flex flex-col text-muted">
            {r.machineCodes.map((c) => (
              <span key={c}>{code(c)}</span>
            ))}
          </span>
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
      header: "Butikens andel",
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.compensationOre,
      csv: (r) => r.compensationOre / 100,
      render: (r) => sek(r.compensationOre),
    },
    {
      key: "profit",
      // Före butikens andel; efter den ("Vår del") med vyknappen eller vald butik.
      header: ourProfitLabel(showStoreShare),
      numeric: true,
      hideOnMobile: true,
      sortValue: (r) => r.profitOre,
      csv: (r) => r.profitOre / 100,
      render: (r) => sek(r.profitOre),
    },
    {
      key: "earned",
      // Kort månad i rubriken ("Intjänat nov."), så att kolumnen inte breddar tabellen.
      header: `Intjänat ${shortMonth(monthLabel)}`,
      numeric: true,
      // Månadens ersättning står i nyckeltalen och på butikens sida; under md får
      // periodens intäkt plats bredvid butiken utan sidledsscroll.
      hideOnMobile: true,
      sortValue: (r) => r.earnedMonthOre,
      csv: (r) => r.earnedMonthOre / 100,
      render: (r) => sek(r.earnedMonthOre),
    },
  ];
  // Butikens andel (periodens och månadens) bara med "Visa butikernas andel" eller vald butik.
  return showStoreShare ? all : all.filter((c) => !STORE_SHARE_COLUMNS.has(c.key));
}

/** Kolumnerna med butikens andel, som döljs utan vyknappen. */
export const STORE_SHARE_COLUMNS: ReadonlySet<string> = new Set(["compensation", "earned"]);

/** Kolumnernas nycklar i ordning (för test). */
export function storeColumnKeys(showStoreShare: boolean): string[] {
  return columns("november", showStoreShare).map((c) => c.key);
}

/** Butikerna med periodens intäkt och ersättning och vad de tjänat hittills i månaden. */
export function StoreTable({
  rows,
  caption,
  monthLabel,
  showStoreShare = true,
}: {
  rows: readonly StoreRow[];
  caption: string;
  monthLabel: string;
  /** Kolumnerna med butikens andel (vyknappen "Visa butikernas andel" eller vald butik). */
  showStoreShare?: boolean;
}) {
  const cols = useMemo(() => columns(monthLabel, showStoreShare), [monthLabel, showStoreShare]);
  return (
    <DataTable
      surface="bg"
      columns={cols}
      rows={rows}
      rowKey={(r) => r.id}
      caption={caption}
      columnPicker
      exportFileName="butiker"
    />
  );
}
