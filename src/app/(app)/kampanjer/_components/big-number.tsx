"use client";

import { CountUp } from "@/components/ui/count-up";
import { formatInt } from "@/lib/format";

/** Sidans stora siffra, som räknar upp (inte med prefers-reduced-motion). */
export function BigNumber({ value, id }: { value: number; id: string }) {
  return <CountUp value={value} format={formatInt} id={id} className="tnum" />;
}
