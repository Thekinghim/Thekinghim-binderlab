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
      {summary ? <p className="meta text-muted">{summary}</p> : null}
      {list.rows.length === 0 ? (
        <StateMessage compact kind="empty" code="0 rader" message="Ingen försäljning i perioden." />
      ) : (
        // key={kind}: listan monteras om vid flikbyte, så att raderna glider in igen.
        <ol key={kind} className="flex flex-col">
          {list.rows.map((r, i) => (
            <MoverItem key={r.key} row={r} index={i} />
          ))}
        </ol>
      )}
      {list.total > list.rows.length ? (
        <p className="meta text-subtle">{`Topp ${formatInt(list.rows.length)} av ${formatInt(list.total)}.`}</p>
      ) : null}
    </div>
  );
}

function RankMove({ move }: { move: number | null }) {
  if (move === null || move === 0) return null;
  return (
    <span className="tnum meta inline-flex items-center gap-1 text-muted">
      <DeltaGlyph up={move > 0} />
      {formatInt(Math.abs(move))}
      <span className="sr-only">{move > 0 ? " placeringar upp" : " placeringar ned"}</span>
    </span>
  );
}

function MoverItem({ row: r, index }: { row: MoverRow; index: number }) {
  const body = (
    <>
      <span className="tnum label text-subtle">{formatInt(r.rank)}</span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-base text-fg">
            {r.code ? (
              <>
                {r.code}
                {NBSP}
                <span className="text-muted">{r.name}</span>
              </>
            ) : (
              r.name
            )}
          </span>
          <RankMove move={r.rankMove} />
        </span>
        <span aria-hidden className="h-1.5 overflow-hidden rounded-xs bg-line">
          <span
            className="grow-x block h-full rounded-xs bg-fg/70"
            style={{ width: `${Math.round(r.bar * 100)}%`, "--i": index } as CSSProperties}
          />
        </span>
      </span>
      <span className="flex flex-col items-end">
        <span className="tnum text-base text-fg">{kr(r.revenueOre)}</span>
        {r.changeText ? (
          <span
            className={cn(
              "tnum meta inline-flex items-center gap-1",
              r.changeBp === null || r.changeBp === 0 ? "text-muted" : "text-fg",
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
    <li
      className="rise border-t border-line first:border-t-0"
      style={{ "--i": index } as CSSProperties}
    >
      {r.href ? (
        <Link href={r.href} className={cn(cls, "hover:bg-hover")}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}
