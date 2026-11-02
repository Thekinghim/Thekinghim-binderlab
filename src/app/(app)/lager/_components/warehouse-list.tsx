"use client";

import { StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatInt, MISSING, NBSP } from "@/lib/format";

import { formatWhen, STATUS_LABEL, STATUS_TONE } from "../_lib/display";
import type { LagerTitle, WarehouseRow } from "../_lib/types";

const GRID =
  "grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 md:grid-cols-[minmax(0,1fr)_96px_96px_120px_112px]";

/**
 * Centrallagret: antal per titel, hur länge det räcker vid alla automaters takt och vad
 * veckans besök behöver. En rad öppnar inventering för den som får registrera.
 */
export function WarehouseList({
  rows,
  titles,
  timeZone,
  now,
  canRegister,
  onSelect,
}: {
  rows: WarehouseRow[];
  titles: Map<string, LagerTitle>;
  timeZone: string;
  now: string;
  canRegister: boolean;
  onSelect: (title: LagerTitle, row: WarehouseRow) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className={cn(GRID, "border-b border-line-strong pb-2")}>
        <span className="label text-subtle">Titel</span>
        <span className="label hidden text-right text-subtle md:block">Räcker</span>
        <span className="label hidden text-right text-subtle md:block">Behov 7 d</span>
        <span className="label text-right text-subtle">I lager</span>
        <span className="label text-left text-subtle md:text-left">Status</span>
      </div>
      <ul aria-label="Centrallager per titel">
        {rows.map((r) => {
          const title = titles.get(r.titleId);
          if (!title) return null;
          const days = r.daysLeft === null ? MISSING : `${formatInt(r.daysLeft)}${NBSP}d`;
          const body = (
            <>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-base text-fg">{title.name}</span>
                <span className="meta text-subtle md:hidden">
                  räcker {days} · behov {formatInt(r.weekNeed)}
                </span>
                <span className="meta hidden text-subtle md:block">
                  inventerat {formatWhen(r.lastCountedAt, timeZone, now)}
                </span>
              </span>
              <span className="tnum hidden text-right text-sm text-muted md:block">{days}</span>
              <span className="tnum hidden text-right text-sm text-muted md:block">
                {formatInt(r.weekNeed)}
                {r.shortBy > 0 ? ` (${formatInt(r.shortBy)} saknas)` : ""}
              </span>
              <span className="tnum text-right text-xl font-medium">{formatInt(r.onHand)}</span>
              <span>
                <StatusTag status={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusTag>
              </span>
            </>
          );
          const cls = cn(GRID, "min-h-14 py-2 text-left");
          return (
            <li key={r.titleId} className="border-b border-line">
              {canRegister ? (
                <button
                  type="button"
                  className={cn(
                    cls,
                    "transition-colors duration-fast ease-instrument hover:bg-hover focus-visible:-outline-offset-2",
                  )}
                  aria-label={`${title.name} i centrallagret: ${formatInt(r.onHand)} pack, räcker ${days}, behov ${formatInt(r.weekNeed)} den närmaste veckan. Status ${STATUS_LABEL[r.status]}. Registrera inventering.`}
                  onClick={() => onSelect(title, r)}
                >
                  {body}
                </button>
              ) : (
                <div className={cls}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
