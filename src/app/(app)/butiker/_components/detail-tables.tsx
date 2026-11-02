"use client";

import Link from "next/link";
import { useMemo } from "react";

import { parseIsoDate, wallClockIn } from "@/components/shell/period-state";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatDate, formatInt, formatSek, MISSING, NBSP } from "@/lib/format";

import type { AgreementState, AgreementView, RecipientView, StoreMachineRow } from "../_lib/types";
import { percentBp } from "../_lib/model";
import { EditAgreementButton } from "./agreement-dialogs";
import { RecipientActions } from "./recipient-dialogs";

function sek(ore: number): string {
  return formatSek(ore / 100);
}

function day(iso: string, today: Date): string {
  const d = parseIsoDate(iso);
  return d ? formatDate(d, { year: "auto", now: today }) : MISSING;
}

const STATE: Record<AgreementState, { status: Status; label: string }> = {
  current: { status: "ok", label: "Gäller" },
  upcoming: { status: "neutral", label: "Kommande" },
  ended: { status: "offline", label: "Avslutat" },
};

// ---------------------------------------------------------------------------
// Avtal
// ---------------------------------------------------------------------------

function agreementColumns(
  today: Date,
  canEdit: boolean,
  storeName: string,
): Column<AgreementView>[] {
  const cols: Column<AgreementView>[] = [
    {
      key: "period",
      header: "Giltighet",
      sortValue: (a) => a.validFrom,
      hideable: false,
      render: (a) => (
        <span className="flex flex-col">
          <span className="tnum text-fg">
            {day(a.validFrom, today)}
            {NBSP}–{NBSP}
            {a.validTo ? day(a.validTo, today) : "tills vidare"}
          </span>
          <span className="text-sm text-muted md:hidden">{a.termsLabel}</span>
          {a.note ? <span className="text-sm text-muted">{a.note}</span> : null}
        </span>
      ),
    },
    {
      key: "state",
      header: "Status",
      sortValue: (a) => (a.state === "current" ? 0 : a.state === "upcoming" ? 1 : 2),
      hideable: false,
      render: (a) => <StatusTag status={STATE[a.state].status}>{STATE[a.state].label}</StatusTag>,
    },
    {
      key: "commission",
      header: "Provision",
      numeric: true,
      hideOnMobile: true,
      sortValue: (a) => a.commissionBp ?? -1,
      render: (a) => (a.commissionBp === null ? MISSING : percentBp(a.commissionBp)),
    },
    {
      key: "rent",
      header: "Hyra/mån",
      numeric: true,
      hideOnMobile: true,
      sortValue: (a) => a.monthlyRentOre ?? -1,
      render: (a) => (a.monthlyRentOre === null ? MISSING : sek(a.monthlyRentOre)),
    },
  ];
  if (canEdit) {
    cols.push({
      key: "actions",
      header: "Åtgärd",
      hideable: false,
      className: "text-right",
      render: (a) => (
        <span className="flex justify-end">
          <EditAgreementButton agreement={a} storeName={storeName} />
        </span>
      ),
    });
  }
  return cols;
}

/** Avtalshistoriken, senaste först. */
export function AgreementsTable({
  agreements,
  today,
  canEdit,
  storeName,
}: {
  agreements: readonly AgreementView[];
  today: string;
  canEdit: boolean;
  storeName: string;
}) {
  const ref = parseIsoDate(today) ?? new Date();
  const cols = useMemo(
    () => agreementColumns(ref, canEdit, storeName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today, canEdit, storeName],
  );
  return (
    <DataTable
      surface="bg"
      columns={cols}
      rows={agreements}
      rowKey={(a) => a.id}
      caption={`Avtal med ${storeName}, senaste först`}
      dense
    />
  );
}

// ---------------------------------------------------------------------------
// Automater
// ---------------------------------------------------------------------------

function machineColumns(todayIso: string): Column<StoreMachineRow>[] {
  const today = parseIsoDate(todayIso) ?? new Date();
  return [
    {
      key: "machine",
      header: "Automat",
      sortValue: (m) => m.code,
      hideable: false,
      render: (m) => (
        <Link
          href={m.href}
          className="flex max-w-36 min-w-0 flex-col rounded-xs py-1 hover:text-fg md:max-w-none"
        >
          <span className="meta text-fg">{m.code.replace(/-/g, "‑")}</span>
          <span className="truncate text-sm text-muted" title={m.name}>
            {m.name}
          </span>
        </Link>
      ),
    },
    {
      key: "placement",
      header: "Placering",
      sortValue: (m) => m.from,
      render: (m) =>
        m.current ? (
          <span className="flex flex-col items-start gap-1">
            <StatusTag status="ok">Står här</StatusTag>
            <span className="meta text-subtle">sedan {day(m.from, today)}</span>
          </span>
        ) : (
          <span className="flex flex-col items-start gap-1">
            <StatusTag status={m.from > todayIso ? "neutral" : "offline"}>
              {m.from > todayIso ? "Kommande" : "Flyttad"}
            </StatusTag>
            <span className="meta text-subtle">
              {day(m.from, today)}
              {NBSP}–{NBSP}
              {m.to ? day(m.to, today) : ""}
            </span>
          </span>
        ),
    },
    {
      key: "orders",
      header: "Sålda pack",
      numeric: true,
      hideOnMobile: true,
      sortValue: (m) => m.orders,
      render: (m) => formatInt(m.orders),
    },
    {
      key: "revenue",
      // Kort huvud så att beloppet ryms i 375 px; sektionen säger redan att det gäller butiken.
      header: "Intäkt",
      numeric: true,
      sortValue: (m) => m.revenueOre,
      render: (m) => sek(m.revenueOre),
    },
  ];
}

export function MachinesTable({
  machines,
  today,
  caption,
}: {
  machines: readonly StoreMachineRow[];
  today: string;
  caption: string;
}) {
  const cols = useMemo(() => machineColumns(today), [today]);
  return (
    <DataTable
      surface="bg"
      columns={cols}
      rows={machines}
      rowKey={(m) => m.placementId}
      caption={caption}
    />
  );
}

// ---------------------------------------------------------------------------
// Rapportmottagare
// ---------------------------------------------------------------------------

function recipientColumns(timeZone: string, now: Date, canEdit: boolean): Column<RecipientView>[] {
  const localNow = wallClockIn(now, timeZone);
  const cols: Column<RecipientView>[] = [
    {
      key: "name",
      header: "Mottagare",
      sortValue: (r) => r.name,
      hideable: false,
      render: (r) => (
        // max-w under md: adressen kortas med ellips (hela står i title) i stället för att
        // göra tabellen bredare än skärmen.
        <span className="flex max-w-32 min-w-0 flex-col md:max-w-none">
          <span className="text-fg">{r.name}</span>
          <span className="meta truncate text-muted" title={r.email}>
            {r.email}
          </span>
        </span>
      ),
    },
    {
      // Status och senaste rapport i samma kolumn, så att tabellen ryms bredvid
      // kontaktuppgifterna med åtgärderna synliga.
      key: "status",
      header: "Status",
      sortValue: (r) => (r.active ? 0 : 1),
      hideable: false,
      render: (r) => (
        <span className="flex flex-col items-start gap-1">
          {r.active ? (
            <StatusTag status="ok">Aktiv</StatusTag>
          ) : (
            <StatusTag status="offline">Pausad</StatusTag>
          )}
          <span className="meta text-subtle">
            {r.lastSentAt
              ? `Senast ${formatDate(wallClockIn(new Date(r.lastSentAt), timeZone), {
                  year: "auto",
                  now: localNow,
                })}`
              : "Ingen rapport ännu"}
          </span>
        </span>
      ),
    },
  ];
  if (canEdit) {
    cols.push({
      key: "actions",
      header: "Åtgärd",
      hideable: false,
      className: "text-right",
      render: (r) => <RecipientActions recipient={r} />,
    });
  }
  return cols;
}

export function RecipientsTable({
  recipients,
  timeZone,
  now,
  canEdit,
  caption,
}: {
  recipients: readonly RecipientView[];
  timeZone: string;
  now: string;
  canEdit: boolean;
  caption: string;
}) {
  const cols = useMemo(
    () => recipientColumns(timeZone, new Date(now), canEdit),
    [timeZone, now, canEdit],
  );
  return (
    <DataTable
      surface="bg"
      columns={cols}
      rows={recipients}
      rowKey={(r) => r.id}
      caption={caption}
    />
  );
}
