"use client";

import { useId, useState } from "react";

import { cn } from "@/lib/cn";

import { formatValue, type ValueUnit } from "./format";

export type LineSeries = {
  readonly key: string;
  readonly label: string;
  /** Ett värde per x (null = saknas). */
  readonly values: ReadonlyArray<number | null>;
  /** Streckad (förra perioden, "i går"). */
  readonly dashed?: boolean;
  readonly tone?: "ink" | "profit" | "muted";
};

const STROKE = { ink: "var(--v2-ink)", profit: "var(--v2-profit)", muted: "var(--v2-line3)" };

/**
 * Linjediagram (I dag mot i går, vinst per vecka): en eller flera serier över samma x-axel,
 * streckad för jämförelsen, en lodrät markör och tooltip vid pekaren. Linjen tonar in en gång
 * (av vid reducerad rörelse).
 */
export function LineChart({
  series,
  labels,
  height = 140,
  unit = "int",
  format,
  ariaLabel,
  className,
}: {
  series: ReadonlyArray<LineSeries>;
  /** Etikett per x ("08", "10" …). */
  labels: ReadonlyArray<string>;
  height?: number;
  /** Talens enhet (går att skicka från en serverkomponent). */
  unit?: ValueUnit;
  /** Egen formatering (bara från klientkomponenter). Går före `unit`. */
  format?: (value: number) => string;
  ariaLabel: string;
  className?: string;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const fmt = (v: number) => (format ? format(v) : formatValue(v, unit));
  const n = Math.max(1, labels.length - 1);
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const W = 100;
  const y = (v: number) => height - ((v - min) / (max - min || 1)) * (height - 6) - 3;
  const path = (values: ReadonlyArray<number | null>) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${((i / n) * W).toFixed(2)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  return (
    <figure className={cn("relative m-0", className)} aria-labelledby={`${id}-c`}>
      <figcaption id={`${id}-c`} className="sr-only">
        {ariaLabel}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height }}
        aria-hidden="true"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(n, Math.round(((e.clientX - r.left) / r.width) * n))));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <line
          x1="0"
          x2={W}
          y1={height - 0.5}
          y2={height - 0.5}
          stroke="var(--v2-line)"
          vectorEffect="non-scaling-stroke"
        />
        {series.map((s) => (
          <path
            key={s.key}
            d={path(s.values)}
            fill="none"
            stroke={STROKE[s.tone ?? (s.dashed ? "muted" : "ink")]}
            strokeWidth={s.dashed ? 1.25 : 1.75}
            strokeDasharray={s.dashed ? "3 3" : undefined}
            vectorEffect="non-scaling-stroke"
            className={s.dashed ? undefined : "v2-line-in"}
          />
        ))}
        {hover !== null ? (
          <line
            x1={(hover / n) * W}
            x2={(hover / n) * W}
            y1="0"
            y2={height}
            stroke="var(--v2-line3)"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className="mt-1.5 flex justify-between text-v2-xs text-v2-faint" aria-hidden="true">
        {labels.map((l, i) =>
          labels.length > 8 &&
          i % Math.ceil(labels.length / 6) !== 0 &&
          i !== labels.length - 1 ? null : (
            <span key={`${l}-${i}`}>{l}</span>
          ),
        )}
      </div>
      {hover !== null ? (
        <span className="v2-tip" style={{ left: `${(hover / n) * 100}%`, top: 8 }}>
          <b>{labels[hover]}</b>
          {series
            .map((s) => {
              const v = s.values[hover];
              return v === null || v === undefined ? null : `${s.label} ${fmt(v)}`;
            })
            .filter(Boolean)
            .join(" · ")}
        </span>
      ) : null}
      <table className="sr-only">
        <thead>
          <tr>
            <th scope="col">Tid</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={`${l}-${i}`}>
              <th scope="row">{l}</th>
              {series.map((s) => (
                <td key={s.key}>{s.values[i] == null ? "–" : fmt(s.values[i]!)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
