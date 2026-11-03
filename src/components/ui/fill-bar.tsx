"use client";

import { useEffect, useState } from "react";

import { fillPercent, fillTone } from "@/analytics/visits/fill";
import { cn } from "@/lib/cn";
import { NBSP } from "@/lib/format";

const TONE: Record<ReturnType<typeof fillTone>, string> = {
  critical: "bg-signal",
  warning: "bg-fill-mid",
  ok: "bg-fill-ok",
};

/**
 * Smal stapel för fyllnadsgraden (bp, 10 000 = full). Växer från 0 när den visas;
 * utan rörelse (prefers-reduced-motion) står den direkt på värdet.
 */
export function FillBar({
  bp,
  className,
  delayMs = 0,
}: {
  bp: number;
  className?: string;
  delayMs?: number;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const pct = Math.min(100, Math.max(0, bp / 100));
  return (
    <span aria-hidden className={cn("block h-1.5 overflow-hidden rounded-full bg-line", className)}>
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-700 ease-instrument",
          TONE[fillTone(bp)],
        )}
        style={{ width: shown ? `${pct}%` : "0%", transitionDelay: `${delayMs}ms` }}
      />
    </span>
  );
}

/** Stapel och procent, eller "–" utan kapacitet. */
export function FillValue({
  bp,
  className,
  delayMs,
}: {
  bp: number | null;
  className?: string;
  delayMs?: number;
}) {
  if (bp === null) {
    return (
      <span className={cn("meta text-subtle", className)} aria-label="Fyllnad okänd">
        –
      </span>
    );
  }
  const pct = fillPercent(bp);
  return (
    <span
      className={cn("inline-flex items-center gap-2", className)}
      aria-label={`Fyllnad ${pct}${NBSP}%`}
    >
      <FillBar bp={bp} className="w-16" {...(delayMs !== undefined ? { delayMs } : {})} />
      <span className="tnum w-10 text-right text-sm text-fg">{`${pct}${NBSP}%`}</span>
    </span>
  );
}
