"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { MINUS, NBSP, formatDelta, formatNumber } from "@/lib/format";
import { motion } from "@/lib/tokens";

/**
 * Hur ett nytt värde visas vid periodbyte.
 * - "fade": värdet byts direkt och tonar 0,4 → 1 på 150 ms.
 *   Siffran är aldrig fel, inte ens under övergången.
 * - "count": räknar upp (standard i KpiStrip och KpiCard; heltal från 0 när de visas).
 * - "none": byts direkt.
 * Ingen rörelse alls vid prefers-reduced-motion.
 */
export type KpiMotion = "fade" | "count" | "none";

/** relative: andel (0.12 = +12 %). absolute: i värdets egen enhet (+2 st). */
export type KpiDeltaKind = "relative" | "absolute";

export type KpiDeltaSpec = {
  delta: number;
  kind?: KpiDeltaKind;
  /** Enhet för absolut delta, t.ex. "st" eller "p.e." */
  unit?: string;
  /** Egen formatering av deltat; går före kind/unit */
  format?: (d: number) => string;
  /** Minskning är bra (t.ex. tomma fack, svinn, stopptid) */
  invert?: boolean;
};

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Tonar in elementet när `key` byts. Första renderingen animeras inte. */
export function useValueFade<T extends HTMLElement>(key: string, enabled = true) {
  const ref = useRef<T>(null);
  const prev = useRef(key);
  useEffect(() => {
    if (prev.current === key) return;
    prev.current = key;
    const el = ref.current;
    if (!enabled || !el || typeof el.animate !== "function" || reducedMotion()) return;
    el.animate([{ opacity: 0.4 }, { opacity: 1 }], {
      duration: motion.base,
      easing: `cubic-bezier(${motion.ease.join(",")})`,
    });
  }, [key, enabled]);
  return ref;
}

/**
 * Visat värde enligt vald rörelse. Bara läget "count" startar en
 * bildrutsloop; "fade" och "none" returnerar värdet direkt utan att
 * rendera om cellen under övergången.
 */
export function useKpiValue(value: number, mode: KpiMotion): number {
  const counting = mode === "count";
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (!counting) {
      from.current = value;
      return;
    }
    const start = from.current;
    let frame = 0;
    if (start === value || reducedMotion()) {
      from.current = value;
      frame = requestAnimationFrame(() => setShown(value));
      return () => cancelAnimationFrame(frame);
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / motion.count);
      const next = start + (value - start) * (1 - Math.pow(1 - t, 3));
      from.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, counting]);
  return counting ? shown : value;
}

export function formatKpiDelta({ delta, kind = "relative", unit, format }: KpiDeltaSpec): string {
  if (format) return format(delta);
  if (kind === "relative") return formatDelta(delta, Math.abs(delta) < 0.1 ? 1 : 0);
  const digits = Number.isInteger(delta) ? 0 : 1;
  const rounded = Number(Math.abs(delta).toFixed(digits));
  const sign = rounded === 0 ? "±" : delta > 0 ? "+" : MINUS;
  return `${sign}${formatNumber(rounded, digits)}${unit ? `${NBSP}${unit}` : ""}`;
}

/**
 * Riktning + tal + (valfri) jämförelsetext. Förbättring och försämring
 * visas med samma tyngd (fg): glyf och tecken bär riktningen, och en
 * försämring får aldrig se tystare ut än en förbättring. Bara
 * "oförändrat" är muted. Skärmläsare får "förbättring"/"försämring".
 */
export function KpiDelta({
  spec,
  label,
  className,
}: {
  spec: KpiDeltaSpec;
  /** T.ex. "mot föregående period". Utelämnas när jämförelsen står i remsans huvud. */
  label?: string;
  className?: string;
}) {
  const { delta, invert } = spec;
  const flat = Math.abs(delta) < 1e-9;
  const good = flat ? undefined : invert ? delta < 0 : delta > 0;
  const text = formatKpiDelta(spec);
  return (
    <p
      className={cn(
        "meta tnum flex flex-wrap items-center gap-x-2 gap-y-0.5 text-subtle",
        className,
      )}
    >
      <span className={cn("inline-flex items-center gap-1", flat ? "text-muted" : "text-fg")}>
        {flat ? <FlatGlyph /> : <DeltaGlyph up={delta > 0} />}
        <span>{text}</span>
        <span className="sr-only">
          {flat ? "oförändrat" : good ? "(förbättring)" : "(försämring)"}
        </span>
      </span>
      {label ? <span>{label}</span> : null}
    </p>
  );
}

/** Larmrad: signalkvadrat + text. Den enda markeringen för ett nyckeltal som kräver åtgärd. */
export function KpiAlert({ children, className }: { children: string; className?: string }) {
  return (
    <p className={cn("label flex items-center gap-1.5 text-signal-fg", className)}>
      <span aria-hidden className="size-1.5 shrink-0 bg-signal" />
      <span className="sr-only">Kräver åtgärd: </span>
      {children}
    </p>
  );
}

export function DeltaGlyph({ up }: { up: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden className="shrink-0">
      <path d={up ? "M4 0.5 L7.5 7 L0.5 7Z" : "M4 7.5 L7.5 1 L0.5 1Z"} fill="currentColor" />
    </svg>
  );
}

function FlatGlyph() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden className="shrink-0">
      <path d="M0.5 4h7" stroke="currentColor" />
    </svg>
  );
}
