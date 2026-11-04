"use client";

import type { CSSProperties, ReactNode } from "react";

import { CountUp } from "@/components/ui/count-up";
import { cn } from "@/lib/cn";
import { formatInt } from "@/lib/format";

import { splitNumber } from "../_lib/head";

/**
 * Sidans huvud i Butiker, Kontrakt och Expansion: liten etikett, en kort mening där första
 * talet räknar upp, en grå rad och sidans huvudknapp. Tabellsiffror, så inget hoppar.
 */
export function PageHead({
  eyebrow,
  title,
  aside,
  actions,
  tone,
  id,
}: {
  eyebrow: string;
  title: string;
  aside?: string;
  actions?: ReactNode;
  /** Färg på talet: grönt = bra, rött = behöver åtgärd. */
  tone?: "good" | "bad";
  id?: string;
}) {
  const head = splitNumber(title);
  return (
    <header
      className="rise flex flex-col gap-3 max-md:relative max-md:pr-10"
      style={{ "--i": 0 } as CSSProperties}
    >
      {/* Under md står sidans namn redan i underfliken: etiketten bara när den säger mer. */}
      <p className={cn("label text-subtle", !eyebrow.includes("·") && "max-md:hidden")}>
        {eyebrow}
      </p>
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <h1
            id={id}
            className="text-3xl font-medium text-balance text-fg max-md:text-2xl md:text-4xl"
          >
            {head.before}
            {head.value !== null ? (
              <CountUp
                value={head.value}
                format={formatInt}
                id={`head:${eyebrow}`}
                className={
                  tone === "good" ? "tnum text-up" : tone === "bad" ? "tnum text-signal-fg" : "tnum"
                }
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
