"use client";

import Link from "next/link";
import { useState } from "react";

import type { HealthStatus } from "@/analytics/health";
import { fillPercent } from "@/analytics/visits/fill";
import { DataTable, type Column } from "@/components/ui/data-table";
import { FillBar, FillValue } from "@/components/ui/fill-bar";
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
  /** Fyllnadsgrad i bp (Awish-kapaciteten), eller null när den saknas. */
  readonly fillBp: number | null;
}

/** Från Awish-synken; samma text som rubrikens title. */
const FILL_SOURCE = "Från Awish, uppdateras var 10:e minut";

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
        {r.fillBp !== null ? <FillBar bp={r.fillBp} className="mt-1.5 w-24 md:hidden" /> : null}
      </Link>
    ),
    csv: (r) => `${r.code} ${r.name}`,
  },
  {
    key: "status",
    header: "Status",
    sortValue: (r) => r.rank,
    render: (r) => (
      <StatusTag status={HEALTH_TAG[r.status].status}>{HEALTH_TAG[r.status].label}</StatusTag>
    ),
    csv: (r) => HEALTH_TAG[r.status].label,
  },
  {
    key: "fill",
    header: "Fyllnad",
    headerTitle: FILL_SOURCE,
    // Utan kapacitet sist.
    sortValue: (r) => r.fillBp ?? 10_001,
    render: (r) => <FillValue bp={r.fillBp} />,
    csv: (r) => (r.fillBp === null ? "" : fillPercent(r.fillBp)),
    hideOnMobile: true,
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

/**
 * Mobil: en kompakt rad per automat (kod och namn, status, fyllnad) med underlaget bakom
 * en utfällning, i samma ordning som tabellens standardsortering. Från md tabellen.
 */
function HealthList({ rows }: { rows: HealthRow[] }) {
  const [showOk, setShowOk] = useState(false);
  const sorted = [...rows].sort(
    (a, b) => a.rank - b.rank || (a.fillBp ?? 10_001) - (b.fillBp ?? 10_001),
  );
  // Det som behöver en blick först; automater i drift fälls ihop när något annat finns.
  const okCount = sorted.filter((r) => r.status === "ok").length;
  const foldOk = okCount > 0 && okCount < sorted.length && !showOk;
  const shown = foldOk ? sorted.filter((r) => r.status !== "ok") : sorted;
  return (
    <div className="flex flex-col md:hidden">
      <ul aria-label="Status per automat" className="flex flex-col border-y border-line">
        {shown.map((r) => (
          <li key={r.machineId} className="flex flex-col border-b border-line py-2 last:border-b-0">
            <div className="flex min-h-11 items-center gap-3">
              <Link
                href={`/drift/automat/${r.machineId}`}
                className="flex min-w-0 flex-1 flex-col rounded-xs hover:underline max-md:min-h-11 max-md:justify-center"
              >
                <span className="meta text-fg">{r.code.replace("-", "‑")}</span>
                <span className="truncate text-sm text-muted">{r.name}</span>
              </Link>
              {r.fillBp !== null ? (
                <span className="shrink-0">
                  <FillValue bp={r.fillBp} />
                </span>
              ) : null}
              <StatusTag status={HEALTH_TAG[r.status].status} className="shrink-0">
                {HEALTH_TAG[r.status].label}
              </StatusTag>
            </div>
            <details className="group">
              <summary className="meta flex min-h-8 cursor-pointer list-none items-center gap-1 text-subtle hover:text-fg max-md:min-h-11 [&::-webkit-details-marker]:hidden">
                {/* I drift: bara ordet; annars underlaget, som är skälet till statusen. */}
                <span className="line-clamp-2 min-w-0">
                  {r.status === "ok" ? "Underlag" : r.detail}
                </span>
              </summary>
              <dl className="mt-1 mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted">
                <dt className="label text-subtle">Underlag</dt>
                <dd>{r.detail}</dd>
                <dt className="label text-subtle">Sedan</dt>
                <dd>{r.since}</dd>
                <dt className="label text-subtle">Senast sålt</dt>
                <dd>{r.lastSale}</dd>
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
          </li>
        ))}
      </ul>
      {okCount > 0 && okCount < sorted.length ? (
        <button
          type="button"
          aria-expanded={showOk}
          onClick={() => setShowOk((v) => !v)}
          className="label flex min-h-11 w-full items-center justify-between border-b border-line text-left text-muted hover:text-fg"
        >
          {showOk ? "Dölj automater i drift" : `I drift · ${okCount}`}
          <span aria-hidden>{showOk ? "↑" : "↓"}</span>
        </button>
      ) : null}
    </div>
  );
}

export function HealthTable({ rows }: { rows: HealthRow[] }) {
  return (
    <>
      <HealthList rows={rows} />
      <div className="max-md:hidden">
        <DataTableFull rows={rows} />
      </div>
    </>
  );
}

function DataTableFull({ rows }: { rows: HealthRow[] }) {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.machineId}
      caption="Status per automat"
      defaultSort={[
        { key: "status", dir: "asc" },
        { key: "fill", dir: "asc" },
      ]}
      exportFileName="maskinhalsa"
    />
  );
}
