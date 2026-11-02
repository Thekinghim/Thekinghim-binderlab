"use client";

import Link from "next/link";

import type { HealthStatus } from "@/analytics/health";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag } from "@/components/ui/status-tag";

import { HEALTH_TAG } from "../_lib/display";

/** En rad i tabellen (serialiserbar från servern). */
export interface HealthRow {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly status: HealthStatus;
  readonly since: string;
  readonly lastSale: string;
  readonly detail: string;
  readonly rule: string;
  readonly expected: string;
  readonly probability: string;
  /** Sorteringsvärde: allvarligast först. */
  readonly rank: number;
}

const columns: Column<HealthRow>[] = [
  {
    key: "machine",
    header: "Automat",
    sortValue: (r) => r.code,
    render: (r) => (
      <Link
        href={`/drift/automat/${r.machineId}`}
        className="flex min-w-0 flex-col rounded-xs hover:underline"
      >
        <span className="meta text-fg">{r.code.replace("-", "‑")}</span>
        <span className="truncate text-sm text-muted">{r.name}</span>
      </Link>
    ),
    csv: (r) => `${r.code} ${r.name}`,
  },
  {
    key: "status",
    header: "Status",
    sortValue: (r) => r.rank,
    render: (r) => <StatusTag status={HEALTH_TAG[r.status].status}>{HEALTH_TAG[r.status].label}</StatusTag>,
    csv: (r) => HEALTH_TAG[r.status].label,
  },
  {
    key: "since",
    header: "Sedan",
    render: (r) => <span className="meta text-muted">{r.since}</span>,
    hideOnMobile: true,
  },
  {
    key: "lastSale",
    header: "Senaste försäljning",
    render: (r) => <span className="meta text-muted">{r.lastSale}</span>,
    hideOnMobile: true,
  },
  {
    key: "detail",
    header: "Underlag",
    render: (r) => (
      <details className="group max-w-xl">
        <summary className="cursor-pointer list-none text-sm text-fg [&::-webkit-details-marker]:hidden">
          {r.detail}
        </summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted">
          <dt className="label text-subtle">Regel</dt>
          <dd>{r.rule}</dd>
          {r.expected ? (
            <>
              <dt className="label text-subtle">Förväntat</dt>
              <dd className="tnum">{r.expected}</dd>
            </>
          ) : null}
          {r.probability ? (
            <>
              <dt className="label text-subtle">Sannolikhet</dt>
              <dd className="tnum">{r.probability}</dd>
            </>
          ) : null}
        </dl>
      </details>
    ),
    csv: (r) => r.detail,
  },
];

export function HealthTable({ rows }: { rows: HealthRow[] }) {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.machineId}
      caption="Status per automat"
      defaultSort={{ key: "status", dir: "asc" }}
      exportFileName="maskinhalsa"
    />
  );
}
