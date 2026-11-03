"use client";

import { CountUp } from "@/components/ui/count-up";
import { formatSek } from "@/lib/format";

/** Stor summa i kronor som räknar upp (inte med prefers-reduced-motion). */
export function MoneyCount({ ore, id }: { ore: number; id: string }) {
  return <CountUp value={Math.round(ore / 100)} format={formatSek} id={id} className="tnum" />;
}
