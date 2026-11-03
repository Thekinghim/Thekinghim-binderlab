"use client";

import type { CSSProperties, ReactNode } from "react";

import { CountUp } from "@/components/ui/count-up";
import { formatInt } from "@/lib/format";

import { splitHeadNumber } from "../_lib/head-number";

/**
 * Sidans huvud i Vårt lager, Inköp, Prognos och Inköpspriser: liten etikett, en kort
 * mening med en stor siffra som räknar upp, en grå rad och eventuellt en knapp.
 * `live` ger en pulserande prick (data från Awish). Samma storlek före och efter
 * uppräkningen (tabellsiffror), så inget hoppar.
 */
export function PageHead({
  eyebrow,
  title,
  aside,
  actions,
  live,
  id,
}: {
  eyebrow: string;
  title: string;
  aside?: string;
  actions?: ReactNode;
  /** Text bredvid den pulserande pricken, t.ex. "Awish". Utelämnat = ingen prick. */
  live?: string;
  id?: string;
}) {
  const head = splitHeadNumber(title);
  return (
    <header className="rise flex flex-col gap-3" style={{ "--i": 0 } as CSSProperties}>
      <p className="label flex items-center gap-2 text-subtle">
        <span>{eyebrow}</span>
        {live ? (
          <span className="inline-flex items-center gap-1.5 normal-case">
            <span aria-hidden className="live-dot size-1.5 rounded-full bg-up text-up" />
            <span className="sr-only">Live:</span>
            {live}
          </span>
        ) : null}
      </p>
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 id={id} className="text-3xl font-medium text-balance text-fg md:text-4xl">
            {head.before}
            {head.value !== null ? (
              <CountUp
                value={head.value}
                format={formatInt}
                id={`head:${eyebrow}`}
                className="tnum"
              />
            ) : null}
            {head.after}
          </h1>
          {aside ? <p className="text-base text-muted">{aside}</p> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
