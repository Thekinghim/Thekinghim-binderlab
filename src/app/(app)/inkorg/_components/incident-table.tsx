"use client";

import Link from "next/link";

import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag } from "@/components/ui/status-tag";
import { MISSING } from "@/lib/format";

import { kronorOfOre } from "../_lib/model";

export interface IncidentListRow {
  readonly id: string;
  readonly when: string;
  readonly whenSort: string;
  readonly machine: string;
  readonly kind: string;
  readonly title: string;
  readonly status: "open" | "in_progress" | "resolved";
  readonly statusLabel: string;
  readonly assignee: string;
  readonly refundedOre: number;
  readonly summary: string;
}

const columns: Column<IncidentListRow>[] = [
  {
    key: "when",
    header: "Tidpunkt",
    sortValue: (r) => r.whenSort,
    render: (r) => (
      <Link href={`/inkorg/${r.id}`} className="meta rounded-xs text-fg hover:underline max-md:tap">
        {r.when}
      </Link>
    ),
    csv: (r) => r.when,
    // Mobil: står i Ärende-cellen, så att ärendet syns utan att skrolla i sidled.
    hideOnMobile: true,
  },
  {
    key: "status",
    header: "Status",
    sortValue: (r) => (r.status === "open" ? 0 : r.status === "in_progress" ? 1 : 2),
    render: (r) => (
      <StatusTag
        status={r.status === "resolved" ? "ok" : r.status === "open" ? "warning" : "neutral"}
      >
        {r.statusLabel}
      </StatusTag>
    ),
    csv: (r) => r.statusLabel,
    hideOnMobile: true,
  },
  {
    key: "kind",
    header: "Ärende",
    sortValue: (r) => r.kind,
    render: (r) => (
      <Link
        href={`/inkorg/${r.id}`}
        className="flex min-w-0 flex-col rounded-xs hover:underline max-md:min-h-11 max-md:max-w-[calc(100vw-10rem)] max-md:justify-center max-md:gap-1 max-md:py-1"
      >
        <span className="text-sm text-fg">{r.kind}</span>
        {r.summary ? <span className="truncate text-xs text-muted">{r.summary}</span> : null}
        {/* Mobil: status, tid och automat, som har egna kolumner från md. */}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 md:hidden">
          <StatusTag
            status={r.status === "resolved" ? "ok" : r.status === "open" ? "warning" : "neutral"}
          >
            {r.statusLabel}
          </StatusTag>
          <span className="meta text-muted">{`${r.when}${r.machine ? ` · ${r.machine}` : ""}`}</span>
        </span>
      </Link>
    ),
    csv: (r) => `${r.kind}${r.summary ? `: ${r.summary}` : ""}`,
  },
  {
    key: "machine",
    header: "Automat",
    sortValue: (r) => r.machine,
    render: (r) => <span className="meta">{r.machine}</span>,
    hideOnMobile: true,
  },
  {
    key: "title",
    header: "Titel",
    sortValue: (r) => r.title,
    render: (r) => r.title || MISSING,
    hideOnMobile: true,
  },
  {
    key: "assignee",
    header: "Ansvarig",
    sortValue: (r) => r.assignee,
    render: (r) => r.assignee || MISSING,
    hideOnMobile: true,
  },
  {
    key: "refunded",
    header: "Återbetalt",
    numeric: true,
    sortValue: (r) => r.refundedOre,
    render: (r) => (r.refundedOre > 0 ? kronorOfOre(r.refundedOre) : MISSING),
    csv: (r) => r.refundedOre / 100,
  },
];

export function IncidentTable({ rows }: { rows: IncidentListRow[] }) {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      caption="Kundärenden"
      defaultSort={[
        { key: "status", dir: "asc" },
        { key: "when", dir: "desc" },
      ]}
      exportFileName="kundarenden"
    />
  );
}
