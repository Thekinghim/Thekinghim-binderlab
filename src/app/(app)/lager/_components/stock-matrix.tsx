"use client";

import { StatusGlyph } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatInt, MISSING } from "@/lib/format";

import {
  codeText,
  daysLeftLong,
  daysLeftText,
  formatWhen,
  packs,
  STATUS_LABEL,
  statusTone,
} from "../_lib/display";
import type { LagerMachine, LagerTitle, StockCell } from "../_lib/types";

/**
 * Matrisen titel × automat. Varje cell visar antal kvar, dagar kvar och status med
 * text (Kritisk, Låg, OK). För den som får registrera är cellen en knapp (minst 56 px
 * hög) som öppnar påfyllning eller inventering.
 *
 * På mobilen följer kolumnhuvudet med när sidan scrollas (sticky under toppraden). Det
 * kräver att matrisen inte ligger i en egen scrollyta, så ytan klipps i stället
 * (overflow-x: clip) när matrisen får plats från 375 px, dvs. upp till 3 automater.
 * Bredare matriser scrollar i sidled i sin egen yta, och då står huvudet still: en
 * klistrig cell i en egen scrollyta räknar `top` från ytans överkant och skulle annars
 * tryckas ned 56 px över första raden.
 *
 * Ytan är `relative`, så att de visuellt dolda etiketterna (`sr-only`, absolut
 * positionerade) stannar i ytan och inte gör sidan bredare än 375 px.
 */
function fitsWithoutScroll(machines: number): boolean {
  return machines <= 3;
}

/**
 * Kolumnhuvudets cell: klistrig under toppraden (56 px) på mobilen, där påfyllaren
 * scrollar genom matrisen. Från md är kontextraden också klistrig med varierande höjd,
 * och där står huvudet still (top: auto); vänsterkolumnen är klistrig i sidled ändå.
 */
const STICKY_HEAD = "sticky top-14 bg-bg md:top-auto";
/** Kolumnhuvudet när matrisen scrollar i sidled: står still, vänsterkolumnen klistrig. */
const STILL_HEAD = "bg-bg";

export function StockMatrix({
  machines,
  titles,
  cells,
  windowDays,
  timeZone,
  now,
  canRegister,
  onSelect,
}: {
  machines: LagerMachine[];
  titles: LagerTitle[];
  cells: StockCell[][];
  windowDays: number;
  timeZone: string;
  now: string;
  canRegister: boolean;
  onSelect: (machine: LagerMachine, title: LagerTitle, cell: StockCell) => void;
}) {
  const fits = fitsWithoutScroll(machines.length);
  const head = fits ? STICKY_HEAD : STILL_HEAD;
  return (
    <div
      className={cn(
        "relative -mx-4 border-y border-line md:mx-0 md:rounded-md md:border",
        fits ? "overflow-x-clip" : "overflow-x-auto",
      )}
    >
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
              className={cn(
                head,
                "sticky left-0 z-30 w-28 px-4 py-2 text-left align-bottom shadow-[inset_0_-1px_0_var(--bl-line-strong)] md:w-64",
              )}
            >
              <span className="label text-subtle">Titel</span>
            </th>
            {machines.map((m) => (
              <th
                key={m.id}
                scope="col"
                className={cn(
                  head,
                  "z-20 border-l border-line px-2 py-2 text-right align-bottom font-normal shadow-[inset_0_-1px_0_var(--bl-line-strong)]",
                )}
              >
                <span className="label block text-fg">{codeText(m.code)}</span>
                <span className="block truncate text-xs text-subtle" title={m.name}>
                  {m.storeName ?? m.name}
                </span>
                {m.awishSyncedAt ? (
                  <span className="meta block truncate text-subtle">
                    Awish {formatWhen(m.awishSyncedAt, timeZone, now)}
                  </span>
                ) : null}
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
  const label = !cell.stocked
    ? `${title.name} finns inte i ${machine.code}.`
    : !cell.known
      ? `${title.name} i ${machine.code}: saldo okänt.`
      : cell.retired
        ? `${title.name} i ${machine.code}: ${packs(cell.onHand)}. Utgår ur sortimentet, fylls inte på.`
        : `${title.name} i ${machine.code}: ${packs(cell.onHand)}, ${daysLeftLong(cell, windowDays)}. Status ${STATUS_LABEL[cell.status]}.`;
  const body =
    cell.stocked && !cell.known ? (
      // Ingen inventering och inget från Awish: aldrig "tom", bara okänt.
      <>
        <span className="tnum text-xl leading-none font-medium text-subtle">?</span>
        <span className="label text-subtle">Saldo okänt</span>
      </>
    ) : cell.stocked && cell.retired ? (
      // Utgången titel: säljs ut, ingen status och ingen signal (design.md §3).
      <>
        <span className="tnum text-xl leading-none font-medium text-muted">
          {formatInt(cell.onHand)}
        </span>
        <span className="label text-subtle">Utgår</span>
      </>
    ) : cell.stocked ? (
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
            <StatusGlyph
              status={statusTone(cell.status, cell.onHand)}
              size={cell.status === "ok" ? 6 : 8}
            />
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
