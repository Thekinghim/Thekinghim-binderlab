"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";

import { DeltaGlyph } from "@/components/ui/kpi-parts";
import { Segmented } from "@/components/ui/segmented";
import { StateMessage } from "@/components/ui/state-message";
import { cn } from "@/lib/cn";
import { formatInt, formatSek, NBSP } from "@/lib/format";

import { moversSummary, type MoverKind, type MoverList, type MoverRow } from "../_lib/movers";

const OPTIONS: ReadonlyArray<{ value: MoverKind; label: string }> = [
  { value: "machine", label: "Automater" },
  { value: "store", label: "Butiker" },
  { value: "title", label: "Titlar" },
];

const kr = (ore: number) => formatSek(ore / 100);

/** Topplistan: flikar för automater, butiker och titlar; staplarna växer fram vid byte. */
export function MoversList({ lists }: { lists: Record<MoverKind, MoverList> }) {
  const [kind, setKind] = useState<MoverKind>("machine");
  const list = lists[kind];
  const summary = moversSummary(list);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Segmented options={OPTIONS} value={kind} onChange={setKind} label="Topplista" size="sm" />
      {summary ? <p className="text-v2-sm text-v2-mute">{summary}</p> : null}
      {list.rows.length === 0 ? (
        <StateMessage compact kind="empty" code="0 rader" message="Ingen försäljning i perioden." />
      ) : (
        // key={kind}: listan monteras om vid flikbyte, så att staplarna växer fram igen.
        <ol key={kind} className="flex flex-col">
          {list.rows.map((r, i) => (
            <MoverItem key={r.key} row={r} index={i} />
          ))}
        </ol>
      )}
      {list.total > list.rows.length ? (
        <p className="text-v2-xs text-v2-mute">{`Topp ${formatInt(list.rows.length)} av ${formatInt(list.total)}.`}</p>
      ) : null}
    </div>
  );
}

function RankMove({ move }: { move: number | null }) {
  if (move === null || move === 0) return null;
  return (
    <span className="tnum inline-flex items-center gap-1 text-v2-xs text-v2-mute">
      <DeltaGlyph up={move > 0} />
      {formatInt(Math.abs(move))}
      <span className="sr-only">{move > 0 ? " placeringar upp" : " placeringar ned"}</span>
    </span>
  );
}

function MoverItem({ row: r, index }: { row: MoverRow; index: number }) {
  const body = (
    <>
      <span className="tnum text-v2-sm text-v2-mute">{formatInt(r.rank)}</span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-v2-md font-[550] text-v2-ink">
            {r.code ? (
              <>
                {r.code}
                {NBSP}
                <span className="font-normal text-v2-mute">{r.name}</span>
              </>
            ) : (
              r.name
            )}
          </span>
          <RankMove move={r.rankMove} />
        </span>
        <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-v2-track">
          <span
            className="grow-x block h-full rounded-full bg-v2-ink"
            style={{ width: `${Math.round(r.bar * 100)}%`, "--i": index } as CSSProperties}
          />
        </span>
      </span>
      <span className="flex flex-col items-end">
        <span className="tnum text-v2-md text-v2-ink">{kr(r.revenueOre)}</span>
        {r.changeText ? (
          <span
            className={cn(
              "tnum inline-flex items-center gap-1 text-v2-xs",
              r.changeBp === null || r.changeBp === 0 ? "text-v2-mute" : "text-v2-ink",
            )}
          >
            {r.changeBp !== null && r.changeBp !== 0 ? <DeltaGlyph up={r.changeBp > 0} /> : null}
            {r.changeText}
          </span>
        ) : null}
      </span>
    </>
  );
  const cls =
    "grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 transition-colors";
  return (
    <li className="border-t border-v2-line2 first:border-t-0">
      {r.href ? (
        <Link href={r.href} className={cn(cls, "hover:bg-v2-hover")}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}
