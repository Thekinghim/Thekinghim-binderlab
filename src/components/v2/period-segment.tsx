"use client";

import { usePeriod } from "@/components/shell/use-period";
import { cn } from "@/lib/cn";

import { V2_PERIODS, v2PeriodOf } from "./period";
import { Segmented } from "./segmented";

/**
 * 30 dagar / 7 dagar / I dag. Skriver ?period (samma som resten av appen), så att servern
 * räknar om sidan. En annan period i adressen visas som "Eget" (ingen knapp markerad).
 */
export function PeriodSegment({ className }: { className?: string }) {
  const { key, setPeriod } = usePeriod();
  const value = v2PeriodOf(key);
  return (
    <span className={cn("v2-seg-period", className)}>
      {value === null ? <span className="text-v2-sm text-v2-mute">Eget</span> : null}
      <Segmented
        ariaLabel="Period"
        options={V2_PERIODS}
        value={value}
        onChange={(v) => setPeriod({ key: v })}
      />
    </span>
  );
}
