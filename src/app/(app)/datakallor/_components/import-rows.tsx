"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { Segmented } from "@/components/ui/segmented";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatInt, MISSING } from "@/lib/format";

import type { ImportRowFilter } from "../_lib/constants";
import { formatWhenWithYear } from "../_lib/display";
import type { ImportDetail, ImportDetailRow } from "../_lib/types";

// Historik: grå (design.md §3). Fel bärs av den grå varningsetiketten och meddelandet.
const TONE: Record<ImportDetailRow["status"], Status> = {
  new: "ok",
  conflict: "neutral",
  error: "warning",
};
const LABEL: Record<ImportDetailRow["status"], string> = {
  new: "Ny",
  conflict: "Konflikt",
  error: "Fel",
};

/** Radloggen för en import, filtrerad på ?visa= (fel och konflikter som standard). */
export function ImportRows({
  detail,
  filter,
  timeZone,
}: {
  detail: ImportDetail;
  filter: ImportRowFilter;
  timeZone: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const c = detail.counts;

  const columns: Column<ImportDetailRow>[] = [
    {
      key: "row",
      header: "Rad",
      numeric: true,
      sortValue: (r) => r.rowNumber,
      render: (r) => formatInt(r.rowNumber),
      width: 72,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => r.status,
      render: (r) => <StatusTag status={TONE[r.status]}>{LABEL[r.status]}</StatusTag>,
      csv: (r) => LABEL[r.status],
      width: 120,
    },
    {
      key: "order",
      header: "Order",
      sortValue: (r) => r.externalId ?? "",
      render: (r) => <span className="tnum">{r.externalId ?? MISSING}</span>,
      width: 110,
    },
    {
      key: "message",
      header: "Meddelande",
      sortValue: (r) => r.message ?? "",
      render: (r) => (
        <span className="block min-w-[28ch] text-sm whitespace-normal text-fg">
          {r.message ?? MISSING}
        </span>
      ),
    },
    {
      key: "paidAt",
      header: "Betaltid i filen",
      sortValue: (r) => r.paidAt ?? "",
      render: (r) => <span className="tnum whitespace-nowrap">{r.paidAt ?? MISSING}</span>,
      hideOnMobile: true,
      width: 170,
    },
    {
      key: "orderedAt",
      header: "Svensk tid",
      sortValue: (r) => r.orderedAt ?? "",
      render: (r) => (
        <span className="tnum whitespace-nowrap">
          {r.orderedAt ? formatWhenWithYear(r.orderedAt, timeZone) : MISSING}
        </span>
      ),
      csv: (r) => (r.orderedAt ? formatWhenWithYear(r.orderedAt, timeZone) : ""),
      hideOnMobile: true,
      width: 170,
    },
    {
      key: "title",
      header: "Titel",
      sortValue: (r) => r.title ?? "",
      render: (r) => <span className="block max-w-[32ch] truncate">{r.title ?? MISSING}</span>,
      hideOnMobile: true,
    },
    {
      key: "machine",
      header: "Automat",
      sortValue: (r) => r.machine ?? "",
      render: (r) => r.machine ?? MISSING,
      hideOnMobile: true,
      defaultHidden: true,
    },
    {
      key: "amount",
      header: "Belopp i filen",
      sortValue: (r) => r.amount ?? "",
      render: (r) => <span className="tnum whitespace-nowrap">{r.amount ?? MISSING}</span>,
      hideOnMobile: true,
      defaultHidden: true,
    },
  ];

  const emptyText =
    filter === "nya"
      ? "Importen gav inga nya order."
      : filter === "fel"
        ? "Inga rader med fel."
        : filter === "konflikter"
          ? "Inga konflikter."
          : "Inga fel eller konflikter i importen.";

  return (
    <section aria-label="Radlogg" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="label text-muted">
          Radlogg · {formatInt(detail.rows.length)}
          {detail.truncated ? "+" : ""} rader
        </p>
        <Segmented<ImportRowFilter>
          label="Visa rader"
          size="sm"
          value={filter}
          onChange={(v) =>
            startTransition(() =>
              router.replace(v === "problem" ? pathname : `${pathname}?visa=${v}`, {
                scroll: false,
              }),
            )
          }
          options={[
            { value: "problem", label: `Problem ${formatInt(c.error + c.conflict)}` },
            { value: "fel", label: `Fel ${formatInt(c.error)}` },
            { value: "konflikter", label: `Konflikter ${formatInt(c.conflict)}` },
            { value: "nya", label: `Nya ${formatInt(c.new)}` },
          ]}
        />
      </div>
      <div aria-busy={pending || undefined} className={pending ? "opacity-60" : undefined}>
        {detail.rows.length === 0 ? (
          <StateMessage kind="empty" message={emptyText} compact />
        ) : (
          <DataTable
            surface="bg"
            columns={columns}
            rows={detail.rows}
            rowKey={(r) => String(r.rowNumber)}
            caption="Radlogg för importen"
            defaultSort={{ key: "row", dir: "asc" }}
            dense
            toolbar
            columnPicker
            exportFileName={`import-${detail.entry.id.slice(0, 8)}-${filter}`}
          />
        )}
      </div>
      {detail.truncated ? (
        <p className="text-xs text-subtle">
          Visar de första {formatInt(detail.rows.length)} raderna. Exportera eller filtrera för att
          se färre.
        </p>
      ) : null}
      <p className="text-xs text-subtle">
        Dubbletter sparas inte rad för rad, bara som antal. Ej betalda rader räknas men loggas inte.
      </p>
    </section>
  );
}
