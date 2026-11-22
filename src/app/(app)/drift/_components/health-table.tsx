"use client";

import Link from "next/link";
import { useState } from "react";

import type { HealthStatus } from "@/analytics/health";
import { fillPercent } from "@/analytics/visits/fill";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag } from "@/components/ui/status-tag";
import { FillBar } from "@/components/v2/fill-bar";

import { cn } from "@/lib/cn";

import { healthTagFor, type ConnectionLabel } from "../_lib/display";

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
  /** Anslutningen enligt Awish ("Online", "Offline sedan 14:10"), null = okänd. */
  readonly connection: ConnectionLabel | null;
}

/** Statusetiketten: "Strömmen av", "Offline" när Awish säger det, annars hälsans etikett. */
function statusTag(r: HealthRow) {
  return healthTagFor(r.status, r.connection);
}

/** "● Online" / "● Offline sedan 14:10" / "○ Strömmen av …" under automatens namn. */
function Connection({ c }: { c: ConnectionLabel | null }) {
  if (!c) return null;
  const off = c.state === "offline";
  const power = c.state === "power_off";
  return (
    <span
      className={cn(
        "mt-0.5 flex items-center gap-1.5 text-v2-xs",
        off ? "text-v2-crit-text" : "text-v2-mute",
      )}
    >
      <span
        aria-hidden
        className={cn("v2-dot", off ? "critical" : power ? "off" : "bg-v2-profit")}
      />
      {c.text}
    </span>
  );
}

/** Från Awish-synken; samma text som rubrikens title. */
const FILL_SOURCE = "Från Awish, uppdateras var femte minut";

const columns: Column<HealthRow>[] = [
  {
    key: "machine",
    header: "Automat",
    sortValue: (r) => r.code,
    render: (r) => (
      <Link
        href={`/drift/automat/${r.machineId}`}
        className="flex min-w-0 flex-col hover:underline"
      >
        <span className="font-[550] text-v2-ink">{r.code.replace("-", "‑")}</span>
        <span className="truncate text-v2-xs text-v2-mute">{r.name}</span>
        <Connection c={r.connection} />
      </Link>
    ),
    csv: (r) => `${r.code} ${r.name}`,
  },
  {
    key: "status",
    header: "Status",
    sortValue: (r) => r.rank,
    render: (r) => <StatusTag status={statusTag(r).status}>{statusTag(r).label}</StatusTag>,
    csv: (r) => statusTag(r).label,
  },
  {
    key: "fill",
    header: "Fyllnad",
    headerTitle: FILL_SOURCE,
    // Utan kapacitet sist.
    sortValue: (r) => r.fillBp ?? 10_001,
    render: (r) => <FillBar bp={r.fillBp} width={64} />,
    csv: (r) => (r.fillBp === null ? "" : fillPercent(r.fillBp)),
    hideOnMobile: true,
  },
  {
    key: "since",
    header: "Sedan",
    render: (r) => <span className="text-v2-xs text-v2-mute">{r.since}</span>,
    hideOnMobile: true,
  },
  {
    key: "lastSale",
    header: "Senaste försäljning",
    render: (r) => <span className="text-v2-xs text-v2-mute">{r.lastSale}</span>,
    hideOnMobile: true,
  },
  {
    key: "detail",
    header: "Underlag",
    render: (r) => (
      <details className="group max-w-xl">
        <summary className="cursor-pointer list-none text-v2-sm text-v2-ink [&::-webkit-details-marker]:hidden">
          {r.detail}
        </summary>
        <dl className="ops-dl mt-2">
          <dt>Regel</dt>
          <dd>{r.rule}</dd>
          {r.expected ? (
            <>
              <dt>Förväntat</dt>
              <dd>{r.expected}</dd>
            </>
          ) : null}
          {r.probability ? (
            <>
              <dt>Sannolikhet</dt>
              <dd>{r.probability}</dd>
            </>
          ) : null}
        </dl>
      </details>
    ),
    csv: (r) => r.detail,
  },
];

/**
 * Telefon: en rad per automat (kod och namn, fyllnad, status) med underlaget bakom en
 * utfällning, i samma ordning som tabellens standardsortering. Från 900 px tabellen.
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
    <div className="flex flex-col min-[901px]:hidden">
      <ul aria-label="Status per automat" className="ops-list">
        {shown.map((r) => (
          <li key={r.machineId} className="flex flex-col gap-1">
            <div className="flex min-h-11 items-center gap-3">
              <Link
                href={`/drift/automat/${r.machineId}`}
                className="flex min-h-11 min-w-0 flex-1 flex-col justify-center"
              >
                <span className="font-[550] text-v2-ink">{r.code.replace("-", "‑")}</span>
                <span className="truncate text-v2-xs text-v2-mute">{r.name}</span>
                <Connection c={r.connection} />
              </Link>
              <StatusTag status={statusTag(r).status} className="shrink-0">
                {statusTag(r).label}
              </StatusTag>
            </div>
            {r.fillBp !== null ? <FillBar bp={r.fillBp} width={96} /> : null}
            <details className="ops-more">
              {/* I drift: bara ordet; annars underlaget, som är skälet till statusen. */}
              <summary>
                <span className="line-clamp-2 min-w-0">
                  {r.status === "ok" ? "Underlag" : r.detail}
                </span>
              </summary>
              <dl className="ops-dl mt-1 mb-2">
                <dt>Underlag</dt>
                <dd>{r.detail}</dd>
                <dt>Sedan</dt>
                <dd>{r.since}</dd>
                <dt>Senast sålt</dt>
                <dd>{r.lastSale}</dd>
                <dt>Regel</dt>
                <dd>{r.rule}</dd>
                {r.expected ? (
                  <>
                    <dt>Förväntat</dt>
                    <dd>{r.expected}</dd>
                  </>
                ) : null}
                {r.probability ? (
                  <>
                    <dt>Sannolikhet</dt>
                    <dd>{r.probability}</dd>
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
          className="flex min-h-11 w-full items-center justify-between border-t border-v2-line2 px-4 text-left text-v2-sm font-[550] text-v2-mute"
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
      <div className="px-[18px] pb-2 max-[900px]:hidden">
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
