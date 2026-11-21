import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { NBSP } from "@/lib/format";

export type BadgeTone = "success" | "critical" | "warning" | "info" | "neutral" | "plain";

/** Märke (Polaris badge): status eller förändring. Färgen är aldrig ensam bärare av betydelsen. */
export function Badge({
  tone = "neutral",
  dot = false,
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  /** En prick före texten (status, t.ex. "• Offline"). */
  dot?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={cn("v2-badge", tone !== "neutral" && tone, className)} title={title}>
      {dot ? <span className={cn("v2-dot", dotTone(tone))} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

function dotTone(tone: BadgeTone): string | undefined {
  if (tone === "critical") return "critical";
  if (tone === "warning") return "warning";
  if (tone === "info") return "info";
  return undefined;
}

/**
 * Förändringen mot jämförelsen: "↑ 18 %" (grön), "↓ 7 %" (röd), "0 %" (neutral).
 * `bp` i baspunkter (1 800 = 18 %). `unit: "pe"` för procentenheter ("↑ 0,6 p.e.").
 * `goodWhenDown` för tal där ner är bra (kostnader). null = ingen jämförelse (inget ritas).
 */
export function DeltaBadge({
  bp,
  unit = "pct",
  goodWhenDown = false,
}: {
  bp: number | null | undefined;
  unit?: "pct" | "pe";
  goodWhenDown?: boolean;
}) {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return null;
  return <Badge tone={deltaTone(bp, goodWhenDown)}>{deltaText(bp, unit)}</Badge>;
}

/** "↑ 18 %", "↓ 0,6 p.e.", "0 %". Avrundat till hela procent (p.e. med en decimal). */
export function deltaText(bp: number, unit: "pct" | "pe" = "pct"): string {
  const value = unit === "pe" ? Math.round(Math.abs(bp) / 10) / 10 : Math.round(Math.abs(bp) / 100);
  const arrow = value === 0 ? "" : bp > 0 ? "↑" + NBSP : "↓" + NBSP;
  const num =
    unit === "pe" ? value.toLocaleString("sv-SE", { maximumFractionDigits: 1 }) : String(value);
  return `${arrow}${num}${NBSP}${unit === "pe" ? "p.e." : "%"}`;
}

export function deltaTone(bp: number, goodWhenDown = false): BadgeTone {
  const rounded = Math.round(bp / 100);
  if (rounded === 0) return "neutral";
  return rounded > 0 !== goodWhenDown ? "success" : "critical";
}
