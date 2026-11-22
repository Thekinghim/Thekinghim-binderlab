"use client";

import { useState } from "react";

import { Icon } from "@/components/ui/icon";
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
 * Kolumnhuvudet (V2: grå rubrikrad som tabellerna). Matrisen står i ett kort, så huvudet
 * står still; vänsterkolumnen är klistrig i sidled när matrisen scrollar.
 */
const STICKY_HEAD = "bg-v2-hover";
const STILL_HEAD = "bg-v2-hover";

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
  // Mobil: titlar som utgår i alla automater fälls ihop under tabellen.
  const [showRetired, setShowRetired] = useState(false);
  const retiredRow = titles.map((_, i) => {
    const row = cells[i] ?? [];
    return row.some((c) => c.retired) && row.every((c) => c.retired || !c.stocked);
  });
  const retiredCount = retiredRow.filter(Boolean).length;
  return (
    <>
      <div className={cn("relative", fits ? "overflow-x-clip" : "overflow-x-auto")}>
        <table
          className="w-full table-fixed border-collapse text-v2-sm"
          style={{ minWidth: `${112 + machines.length * 76}px` }}
        >
          <caption className="sr-only">
            Lager per titel och automat: antal kvar, dagar kvar och status.
          </caption>
          <thead>
            <tr className="border-b border-v2-line2">
              <th
                scope="col"
                className={cn(
                  head,
                  "sticky left-0 z-30 w-28 px-4 py-2 text-left align-bottom md:w-64 md:px-[18px]",
                )}
              >
                <span className="text-v2-xs font-[550] text-v2-mute">Titel</span>
              </th>
              {machines.map((m) => (
                <th
                  key={m.id}
                  scope="col"
                  className={cn(
                    head,
                    "z-20 border-l border-v2-line2 px-2 py-2 text-right align-bottom font-normal",
                  )}
                >
                  <span className="block text-v2-xs font-[650] text-v2-ink">
                    {codeText(m.code)}
                  </span>
                  <span className="block truncate text-v2-xs text-v2-mute" title={m.name}>
                    {m.storeName ?? m.name}
                  </span>
                  {m.awishSyncedAt ? (
                    <span className="block truncate text-v2-xs text-v2-faint">
                      Awish {formatWhen(m.awishSyncedAt, timeZone, now)}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {titles.map((t, i) => (
              <tr
                key={t.id}
                className={cn(
                  "border-b border-v2-line2 last:border-b-0",
                  retiredRow[i] && !showRetired && "max-md:hidden",
                )}
              >
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-v2-panel px-4 py-2 text-left align-middle text-v2-sm font-[450] hyphens-none text-v2-ink md:px-[18px]"
                >
                  <span className="line-clamp-2 break-words">{t.name}</span>
                </th>
                {(cells[i] ?? []).map((c, j) => {
                  const m = machines[j];
                  if (!m) return null;
                  return (
                    <td key={m.id} className="border-l border-v2-line2 p-0 align-middle">
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
      {retiredCount > 0 ? (
        <button
          type="button"
          aria-expanded={showRetired}
          onClick={() => setShowRetired((v) => !v)}
          className="flex min-h-11 w-full items-center justify-between gap-3 border-t border-v2-line2 px-4 text-left text-v2-sm font-[550] text-v2-mute md:hidden"
        >
          <span>{`${showRetired ? "Dölj utgår" : "Utgår"} (${formatInt(retiredCount)})`}</span>
          <Icon
            name="chevronRight"
            size={12}
            className={cn("transition-transform duration-fast", showRetired && "rotate-90")}
          />
        </button>
      ) : null}
    </>
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
        <span className="tnum text-v2-lg leading-none font-[650] text-v2-faint">?</span>
        <span className="text-v2-xs text-v2-mute">Saldo okänt</span>
      </>
    ) : cell.stocked && cell.retired ? (
      // Utgången titel: säljs ut, ingen status och ingen signal (design.md §3).
      <>
        <span className="tnum text-v2-lg leading-none font-[650] text-v2-mute">
          {formatInt(cell.onHand)}
        </span>
        <span className="text-v2-xs text-v2-mute">Utgår</span>
      </>
    ) : cell.stocked ? (
      <>
        <span className="flex w-full flex-wrap items-baseline justify-end gap-x-2">
          <span className="text-v2-xs text-v2-mute">{daysLeftText(cell)}</span>
          <span className="tnum text-v2-lg leading-none font-[650]">{formatInt(cell.onHand)}</span>
        </span>
        <span
          className={cn(
            "flex items-center gap-1.5 text-v2-xs font-[550]",
            cell.status === "ok" ? "text-v2-mute" : "text-v2-ink",
          )}
        >
          <span
            className={cn(
              "inline-flex w-2 justify-center",
              cell.status === "ok" && "text-v2-faint",
            )}
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
      <span className="text-v2-faint" aria-hidden>
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
        "transition-colors duration-150 hover:bg-v2-hover focus-visible:-outline-offset-2",
      )}
      aria-label={`${label} Registrera påfyllning eller inventering.`}
      onClick={() => onSelect(machine, title, cell)}
    >
      {body}
    </button>
  );
}
