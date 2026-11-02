"use client";

import Link from "next/link";

import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatInt, MISSING } from "@/lib/format";

import { formatWhen, formatWhenWithYear } from "../_lib/display";
import type { ImportLogEntry } from "../_lib/types";

const STATUS: Record<ImportLogEntry["status"], { status: Status; text: string }> = {
  succeeded: { status: "ok", text: "Klar" },
  running: { status: "neutral", text: "Pågår" },
  pending: { status: "neutral", text: "Väntar" },
  // Grå i historiken; signal bara för källans senaste import (se statusOf).
  failed: { status: "warning", text: "Misslyckades" },
};

const TRIGGER: Record<ImportLogEntry["trigger"], string> = {
  upload: "Uppladdning",
  schedule: "Schemalagd",
  webhook: "Webhook",
  extension: "Chrome-tillägg",
};

function count(n: number, flag = false) {
  if (n === 0) return <span className="text-subtle">0</span>;
  return <span className={flag ? "font-medium text-fg" : undefined}>{formatInt(n)}</span>;
}

/** Loggen över alla importer, senaste först. Varje rad länkar till importens radlogg. */
export function ImportLog({
  imports,
  timeZone,
  now,
}: {
  imports: readonly ImportLogEntry[];
  timeZone: string;
  now: string;
}) {
  if (imports.length === 0) {
    return (
      <p className="max-w-xl text-sm text-muted">
        Varje uppladdning hamnar här med antal nya order, dubbletter, konflikter och fel.
      </p>
    );
  }
  const nowDate = new Date(now);
  const when = (e: ImportLogEntry) => e.finishedAt ?? e.startedAt ?? e.createdAt;
  // Signal (design.md §3) bara där någon behöver göra något: en källas senaste import
  // som misslyckades. Gamla misslyckanden och konflikter är historik och grå.
  const latestBySource = new Map<string, ImportLogEntry>();
  for (const e of imports) {
    const prev = latestBySource.get(e.dataSourceId);
    if (!prev || prev.createdAt < e.createdAt) latestBySource.set(e.dataSourceId, e);
  }
  const statusOf = (e: ImportLogEntry): Status =>
    e.status === "failed" && latestBySource.get(e.dataSourceId)?.id === e.id
      ? "critical"
      : STATUS[e.status].status;

  const columns: Column<ImportLogEntry>[] = [
    {
      key: "when",
      header: "Tid",
      sortValue: (e) => when(e),
      render: (e) => (
        <span className="flex flex-col items-start gap-1">
          <Link
            href={`/datakallor/importer/${e.id}`}
            className="tnum whitespace-nowrap text-fg underline-offset-4 hover:underline"
          >
            {formatWhen(when(e), timeZone, nowDate)}
          </Link>
          {/* Under md står statusen här, eftersom statuskolumnen är dold (design.md §5.1). */}
          <span className="md:hidden">
            <StatusTag status={statusOf(e)}>{STATUS[e.status].text}</StatusTag>
          </span>
        </span>
      ),
      csv: (e) => formatWhenWithYear(when(e), timeZone),
      width: 150,
    },
    {
      key: "file",
      header: "Fil",
      // Filnamnet står i importens radlogg; under md får tid, status och antal plats.
      hideOnMobile: true,
      sortValue: (e) => e.fileName ?? "",
      render: (e) => (
        <span
          className="block max-w-[16ch] truncate sm:max-w-[28ch]"
          title={e.fileName ?? undefined}
        >
          {e.fileName ?? TRIGGER[e.trigger]}
        </span>
      ),
    },
    {
      key: "source",
      header: "Källa",
      sortValue: (e) => e.dataSourceName,
      render: (e) => e.dataSourceName,
      hideOnMobile: true,
      defaultHidden: true,
    },
    {
      key: "by",
      header: "Av",
      sortValue: (e) => e.createdBy ?? "",
      render: (e) => e.createdBy ?? MISSING,
      hideOnMobile: true,
    },
    {
      key: "new",
      header: "Nya",
      numeric: true,
      sortValue: (e) => e.rowsNew,
      render: (e) => count(e.rowsNew),
    },
    {
      key: "dup",
      header: "Dubbletter",
      numeric: true,
      sortValue: (e) => e.rowsDuplicate,
      render: (e) => count(e.rowsDuplicate),
      hideOnMobile: true,
    },
    {
      key: "conflict",
      header: "Konflikter",
      numeric: true,
      sortValue: (e) => e.rowsConflict,
      render: (e) => count(e.rowsConflict),
      hideOnMobile: true,
    },
    {
      key: "error",
      header: "Fel",
      numeric: true,
      sortValue: (e) => e.rowsError,
      render: (e) => count(e.rowsError, true),
    },
    {
      key: "notPaid",
      header: "Ej betalda",
      numeric: true,
      sortValue: (e) => e.rowsNotPaid,
      render: (e) => count(e.rowsNotPaid),
      hideOnMobile: true,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (e) => e.status,
      render: (e) => <StatusTag status={statusOf(e)}>{STATUS[e.status].text}</StatusTag>,
      csv: (e) => STATUS[e.status].text,
      hideOnMobile: true,
    },
  ];

  return (
    <DataTable
      surface="bg"
      columns={columns}
      rows={imports}
      rowKey={(e) => e.id}
      caption="Importer, senaste först"
      defaultSort={{ key: "when", dir: "desc" }}
      toolbar
      columnPicker
      exportFileName="importlogg"
    />
  );
}
