"use client";

import { useMemo } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, formatMonth } from "@/lib/format";
import { periodText } from "@/reports/text";
import type { ArchiveRow } from "@/server/reports/service";
import { STATUS_LABEL } from "@/server/reports/status";

import { ReportStatusTag } from "./report-status";
import { when } from "./when";

const TYPE: Record<ArchiveRow["type"], string> = {
  butik: "Butiksrapport",
  bokforing: "Bokföringsunderlag",
  delagare: "Delägarrapport",
};

const STATUS_ORDER = { draft: 0, approved: 1, sent: 2, superseded: 3 } as const;

function monthOf(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return formatMonth(new Date(y!, (mo ?? 1) - 1, 1));
}

/** Alla rapporter med status, mottagare och filer. Nyast period först. */
export function ArchiveTable({
  rows,
  timeZone,
}: {
  rows: readonly ArchiveRow[];
  timeZone: string;
}) {
  const columns = useMemo<Column<ArchiveRow>[]>(
    () => [
      {
        key: "month",
        header: "Period",
        sortValue: (r) => `${r.period.start}|${r.period.end}`,
        render: (r) => (
          <a
            href={`/rapport/${r.id}`}
            className="rounded-xs text-fg underline-offset-4 hover:underline max-md:tap"
          >
            {r.custom ? periodText(r.period) : monthOf(r.month)}
          </a>
        ),
        csv: (r) => (r.custom ? `${r.period.start}–${r.period.end}` : r.month),
        hideable: false,
      },
      {
        key: "type",
        header: "Rapport",
        sortValue: (r) => TYPE[r.type],
        render: (r) => (
          <span className="flex min-w-0 flex-col">
            <span className="text-fg">{TYPE[r.type]}</span>
            {r.storeName ? <span className="text-sm text-muted">{r.storeName}</span> : null}
          </span>
        ),
        csv: (r) => `${TYPE[r.type]}${r.storeName ? ` ${r.storeName}` : ""}`,
      },
      {
        key: "status",
        header: "Status",
        sortValue: (r) => STATUS_ORDER[r.status],
        render: (r) => <ReportStatusTag status={r.status} />,
        csv: (r) => STATUS_LABEL[r.status],
        hideable: false,
      },
      {
        key: "created",
        header: "Skapad",
        sortValue: (r) => r.generatedAt,
        render: (r) => (
          <span className="tnum flex flex-col">
            <span>{when(r.generatedAt, timeZone)}</span>
            <span className="text-sm text-muted">{r.generatedBy ?? "Schemalagd"}</span>
          </span>
        ),
        csv: (r) => r.generatedAt,
        hideOnMobile: true,
      },
      {
        key: "deliveries",
        header: "Utskick",
        numeric: true,
        sortValue: (r) => r.deliveries.length,
        render: (r) => {
          const ok = r.deliveries.filter((d) => d.status !== "failed" && d.status !== "bounced");
          const failed = r.deliveries.length - ok.length;
          return (
            <span className="flex flex-col items-end">
              <span>{formatInt(ok.length)}</span>
              {failed > 0 ? (
                <span className="text-sm text-muted">{formatInt(failed)} misslyckade</span>
              ) : null}
            </span>
          );
        },
        csv: (r) => r.deliveries.length,
        hideOnMobile: true,
      },
      {
        key: "files",
        header: "Filer",
        render: (r) => (
          <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            <a
              href={`/rapport/${r.id}/fil/pdf`}
              className="rounded-xs text-muted underline-offset-4 hover:text-fg hover:underline"
            >
              PDF
            </a>
            {r.type === "bokforing" ? (
              <>
                <a
                  href={`/rapport/${r.id}/fil/xlsx`}
                  className="rounded-xs text-muted underline-offset-4 hover:text-fg hover:underline"
                >
                  Excel
                </a>
                <a
                  href={`/rapport/${r.id}/fil/sie`}
                  className="rounded-xs text-muted underline-offset-4 hover:text-fg hover:underline"
                >
                  SIE
                </a>
              </>
            ) : null}
          </span>
        ),
        hideOnMobile: true,
        hideable: false,
      },
    ],
    [timeZone],
  );

  if (rows.length === 0) {
    return (
      <StateMessage
        kind="empty"
        message="Ingen rapport är skapad ännu."
        detail="Utkast skapas den 1:a varje månad."
        action={{ label: "Skapa ett utkast", href: "#ny-rapport" }}
      />
    );
  }
  return (
    <DataTable
      caption="Arkiv över alla rapporter"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      defaultSort={[
        { key: "month", dir: "desc" },
        { key: "created", dir: "desc" },
      ]}
      exportFileName="rapporter"
      toolbar
    />
  );
}
