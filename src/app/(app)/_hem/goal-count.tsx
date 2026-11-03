"use client";

import { CountUp } from "@/components/ui/count-up";
import { formatInt, formatSek } from "@/lib/format";

const formats = {
  ore: (v: number) => formatSek(v / 100),
  count: (v: number) => formatInt(v),
} as const;

/** Utfallet för ett mål på Hem, uppräknat (formatet väljs här: funktioner går inte från servern). */
export function GoalCount({
  id,
  value,
  unit,
  className,
}: {
  id: string;
  value: number;
  unit: keyof typeof formats;
  className?: string;
}) {
  return <CountUp id={`mal-${id}`} value={value} format={formats[unit]} className={className} />;
}
