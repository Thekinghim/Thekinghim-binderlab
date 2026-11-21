"use client";

import { useId, useState } from "react";

import { cn } from "@/lib/cn";

import { formatValue, type ValueUnit } from "./format";

export type BarDatum = {
  readonly key: string;
  /** Under stapeln ("v. 46", "mån", "14"). */
  readonly label: string;
  /** Stapelns höjd (t.ex. intäkt). */
  readonly value: number;
  /** Del av stapeln som ritas mörk (t.ex. vinsten i intäkten). Utelämnad = hela stapeln. */
  readonly part?: number;
  /** Förra periodens värde: streckad kontur bakom stapeln. */
  readonly previous?: number | null;
};

/**
 * Stapeldiagram (Analys · Resultat, När säljer vi mest): staplar som växer fram med kort
 * förskjutning, mörk del för vinsten, streckad kontur för förra perioden och en tooltip för alla.
 * Tal formateras med `unit` (från servern) eller `format` (från klienten). Allt läses också som tabell av skärmläsare.
 */
export function BarChart({
  data,
  height = 140,
  unit = "int",
  format,
  partLabel = "Vinst",
  valueLabel = "Intäkt",
  ariaLabel,
  className,
}: {
  data: ReadonlyArray<BarDatum>;
  height?: number;
  /** Talens enhet (går att skicka från en serverkomponent). */
  unit?: ValueUnit;
  /** Egen formatering (bara från klientkomponenter). Går före `unit`. */
  format?: (value: number) => string;
  partLabel?: string;
  valueLabel?: string;
  ariaLabel: string;
  className?: string;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const fmt = (v: number) => (format ? format(v) : formatValue(v, unit));
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.previous ?? 0)));
  const active = hover === null ? null : data[hover];
  return (
    <figure className={cn("relative m-0", className)} aria-labelledby={`${id}-c`}>
      <figcaption id={`${id}-c`} className="sr-only">
        {ariaLabel}
      </figcaption>
      <div
        className="flex items-end gap-[3px]"
        style={{ height }}
        onPointerLeave={() => setHover(null)}
        aria-hidden="true"
      >
        {data.map((d, i) => {
          const h = Math.max(0, (d.value / max) * height);
          const p =
            d.part === undefined ? h : Math.max(0, (Math.min(d.part, d.value) / max) * height);
          const prev = d.previous ? (d.previous / max) * height : 0;
          return (
            <div
              key={d.key}
              className="relative flex h-full flex-1 items-end"
              onPointerEnter={() => setHover(i)}
            >
              {prev > 0 ? (
                <span
                  className="absolute inset-x-0 bottom-0 rounded-t-[3px] border border-dashed border-v2-line3"
                  style={{ height: prev }}
                />
              ) : null}
              <span
                className="v2-bar-grow relative w-full overflow-hidden rounded-t-[3px] bg-v2-track"
                style={{ height: h, ["--i" as string]: i }}
              >
                <span
                  className={cn(
                    "absolute inset-x-0 bottom-0",
                    hover === i ? "bg-v2-primary" : "bg-v2-ink/85",
                  )}
                  style={{ height: p }}
                />
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-[3px] text-v2-xs text-v2-faint" aria-hidden="true">
        {data.map((d, i) => (
          <span key={d.key} className="flex-1 truncate text-center">
            {data.length > 14 && i % Math.ceil(data.length / 8) !== 0 ? "" : d.label}
          </span>
        ))}
      </div>
      {active && hover !== null ? (
        <span
          className="v2-tip"
          style={{
            left: `${((hover + 0.5) / data.length) * 100}%`,
            top: height - (active.value / max) * height,
          }}
        >
          <b>{active.label}</b>
          {valueLabel} {fmt(active.value)}
          {active.part !== undefined ? ` · ${partLabel} ${fmt(active.part)}` : ""}
          {active.previous ? ` · förra ${fmt(active.previous)}` : ""}
        </span>
      ) : null}
      <table className="sr-only">
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">{valueLabel}</th>
            {data.some((d) => d.part !== undefined) ? <th scope="col">{partLabel}</th> : null}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <th scope="row">{d.label}</th>
              <td>{fmt(d.value)}</td>
              {d.part !== undefined ? <td>{fmt(d.part)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
