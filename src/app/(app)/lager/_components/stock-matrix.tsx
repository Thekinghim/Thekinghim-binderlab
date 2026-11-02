"use client";

import { StatusGlyph } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatInt, MISSING } from "@/lib/format";

import {
  codeText,
  daysLeftLong,
  daysLeftText,
  packs,
  STATUS_LABEL,
  STATUS_TONE,
} from "../_lib/display";
import type { LagerMachine, LagerTitle, StockCell } from "../_lib/types";

/**
 * Matrisen titel × automat. Varje cell visar antal kvar, dagar kvar och status med
 * text (Kritisk, Låg, OK). För den som får registrera är cellen en knapp (minst 56 px
 * hög) som öppnar påfyllning eller inventering. Breda matriser scrollar i sin egen yta.
 */
export function StockMatrix({
  machines,
  titles,
  cells,
  windowDays,
  canRegister,
  onSelect,
}: {
  machines: LagerMachine[];
  titles: LagerTitle[];
  cells: StockCell[][];
  windowDays: number;
  canRegister: boolean;
  onSelect: (machine: LagerMachine, title: LagerTitle, cell: StockCell) => void;
}) {
  return (
    <div className="-mx-4 overflow-x-auto border-y border-line md:mx-0 md:rounded-md md:border">
      <table
        className="w-full table-fixed border-collapse text-base"
        style={{ minWidth: `${112 + machines.length * 76}px` }}
      >
        <caption className="sr-only">
          Lager per titel och automat: antal kvar, dagar kvar och status.
        </caption>
        <thead>
          <tr className="border-b border-line-strong">
            <th
              scope="col"
              className="sticky left-0 z-10 w-28 bg-bg px-4 py-2 text-left align-bottom md:w-64"
            >
              <span className="label text-subtle">Titel</span>
            </th>
            {machines.map((m) => (
              <th
                key={m.id}
                scope="col"
                className="border-l border-line px-2 py-2 text-right align-bottom font-normal"
              >
                <span className="label block text-fg">{codeText(m.code)}</span>
                <span className="block truncate text-xs text-subtle" title={m.name}>
                  {m.storeName ?? m.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {titles.map((t, i) => (
            <tr key={t.id} className="border-b border-line last:border-b-0">
              <th
                scope="row"
                className="sticky left-0 z-10 bg-bg px-4 py-2 text-left align-middle text-sm font-normal hyphens-none text-fg md:text-base"
              >
                <span className="line-clamp-2 break-words">{t.name}</span>
              </th>
              {(cells[i] ?? []).map((c, j) => {
                const m = machines[j];
                if (!m) return null;
                return (
                  <td key={m.id} className="border-l border-line p-0 align-middle">
                    <Cell
                      cell={c}
                      machine={m}
                      title={t}
                      windowDays={windowDays}
                      canRegister={canRegister}
                      onSelect={onSelect}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({
  cell,
  machine,
  title,
  windowDays,
  canRegister,
  onSelect,
}: {
  cell: StockCell;
  machine: LagerMachine;
  title: LagerTitle;
  windowDays: number;
  canRegister: boolean;
  onSelect: (machine: LagerMachine, title: LagerTitle, cell: StockCell) => void;
}) {
  const label = cell.stocked
    ? `${title.name} i ${machine.code}: ${packs(cell.onHand)}, ${daysLeftLong(cell, windowDays)}. Status ${STATUS_LABEL[cell.status]}.`
    : `${title.name} finns inte i ${machine.code}.`;
  const body = cell.stocked ? (
    <>
      <span className="flex w-full items-baseline justify-end gap-2">
        <span className="meta text-subtle">{daysLeftText(cell)}</span>
        <span className="tnum text-xl leading-none font-medium">{formatInt(cell.onHand)}</span>
      </span>
      <span
        className={cn(
          "label flex items-center gap-1.5",
          cell.status === "ok" ? "text-muted" : "text-fg",
        )}
      >
        <span
          className={cn("inline-flex w-2 justify-center", cell.status === "ok" && "text-subtle")}
        >
          <StatusGlyph status={STATUS_TONE[cell.status]} size={cell.status === "ok" ? 6 : 8} />
        </span>
        {STATUS_LABEL[cell.status]}
      </span>
    </>
  ) : (
    <span className="text-subtle" aria-hidden>
      {MISSING}
    </span>
  );
  const cls = "flex min-h-14 w-full flex-col items-end justify-center gap-1.5 px-2 py-2 text-right";
  if (!canRegister) {
    return (
      <div className={cls}>
        <span className="sr-only">{label}</span>
        <span aria-hidden className="contents">
          {body}
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        cls,
        "transition-colors duration-fast ease-instrument hover:bg-hover focus-visible:-outline-offset-2",
      )}
      aria-label={`${label} Registrera påfyllning eller inventering.`}
      onClick={() => onSelect(machine, title, cell)}
    >
      {body}
    </button>
  );
}
