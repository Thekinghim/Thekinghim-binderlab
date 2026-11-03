"use client";

import type { CSSProperties, ReactNode } from "react";

import { CountUp } from "@/components/ui/count-up";
import { formatInt } from "@/lib/format";

import { splitFirstNumber } from "../_lib/split-number";

/**
 * Sidhuvudet på Mer-sidorna (Inställningar, Användare, Datakällor, Assistent,
 * Marknad, Effekt): liten etikett, EN kort mening där första talet räknar upp,
 * och sidans huvudknapp. Grönt tal = bra, rött = behöver åtgärd. Glider in.
 */
export function MerHead({
  eyebrow,
  title,
  tone,
  live,
  line,
  count = true,
  meta,
  actions,
}: {
  eyebrow: string;
  title: string;
  /** En kort grå rad under rubriken (bara det som hindrar misstag). */
  line?: string;
  /** false: talet i rubriken räknar inte upp (t.ex. ett datum). */
  count?: boolean;
  tone?: "good" | "bad";
  /** Pulserande prick: datan kommer live (Awish). */
  live?: boolean;
  meta?: ReadonlyArray<{ label: string; value: ReactNode }>;
  actions?: ReactNode;
}) {
  const head = count ? splitFirstNumber(title) : { before: title, value: null, after: "" };
  const toneCls = tone === "good" ? "text-up" : tone === "bad" ? "text-signal-fg" : "";
  return (
    <header
      className="rise grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-12"
      style={{ "--i": 0 } as CSSProperties}
    >
      <div className="flex min-w-0 flex-col gap-3 lg:col-span-8">
        <p className="label flex items-center gap-2 text-subtle">
          {live ? (
            <span
              aria-hidden
              className="live-dot inline-block size-1.5 rounded-full bg-up text-up"
            />
          ) : null}
          {eyebrow}
        </p>
        <h1 className="text-3xl font-medium text-balance text-fg md:text-4xl">
          {head.before}
          {head.value !== null ? (
            <CountUp
              value={head.value}
              format={formatInt}
              id={`mer:${eyebrow}`}
              className={`tnum ${toneCls}`}
            />
          ) : null}
          {head.after}
        </h1>
        {line ? <p className="text-base text-muted">{line}</p> : null}
      </div>
      {meta || actions ? (
        <div className="flex flex-col gap-4 lg:col-span-4 lg:items-end">
          {meta && meta.length > 0 ? (
            <dl className="flex w-full flex-col">
              {meta.map((m) => (
                <div
                  key={m.label}
                  className="flex items-baseline justify-between gap-4 border-t border-line py-1.5 last:border-b"
                >
                  <dt className="label text-subtle">{m.label}</dt>
                  <dd className="meta tnum text-fg">{m.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {actions ? (
            <div className="order-first flex flex-wrap items-center gap-2 lg:order-none">
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
