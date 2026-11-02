import { formatDecimal, formatInt, MINUS } from "@/lib/format";

/**
 * Axelenhet för ett helt diagram. En enhet per axel, skriven en gång
 * ovanför axeln i gemener ("tkr"), aldrig på varje tick.
 *
 * - "kr": väljer kr, tkr eller mkr utifrån största |tick|, så att en axel
 *   aldrig blandar "5 000" och "15 tkr".
 * - { label, divisor }: fast enhet, t.ex. { label: "köp" } eller
 *   { label: "%", divisor: 0.01 }.
 */
export type AxisUnit = "kr" | { label: string; divisor?: number };

export type AxisScale = {
  /** Enheten som skrivs ovanför axeln, t.ex. "tkr" */
  label: string;
  divisor: number;
  /** Antal decimaler som gäller för hela axeln (0 eller 1) */
  digits: 0 | 1;
  /** Tick utan enhet: "0", "2", "7,5" */
  tick: (v: number) => string;
  /** Värde i axelns enhet utan enhetsord, med samma decimaler som axeln eller fler */
  value: (v: number, digits?: 0 | 1) => string;
  /** Värde i axelns enhet med enhetsord: "31,1 tkr" */
  withUnit: (v: number, digits?: 0 | 1) => string;
  /** Förändring med tecken: "+2,9", "−26,3" */
  signed: (v: number, digits?: 0 | 1) => string;
};

const NBSP = " ";

function isWhole(v: number) {
  return Math.abs(v - Math.round(v)) < 1e-6;
}

export function axisScale(ticks: ReadonlyArray<number>, unit: AxisUnit = "kr"): AxisScale {
  let divisor = 1;
  let label: string;
  if (unit === "kr") {
    const m = Math.max(0, ...ticks.map((t) => Math.abs(t)));
    if (m >= 1_000_000) {
      divisor = 1_000_000;
      label = "mkr";
    } else if (m >= 1_000) {
      divisor = 1_000;
      label = "tkr";
    } else {
      label = "kr";
    }
  } else {
    divisor = unit.divisor ?? 1;
    label = unit.label;
  }
  const digits: 0 | 1 = ticks.every((t) => isWhole(t / divisor)) ? 0 : 1;
  const fmt = (v: number, d: 0 | 1) =>
    d === 0 ? formatInt(v / divisor) : formatDecimal(v / divisor);
  const value = (v: number, d: 0 | 1 = divisor > 1 ? 1 : digits) => fmt(v, d);
  return {
    label,
    divisor,
    digits,
    tick: (v) => fmt(v, digits),
    value,
    withUnit: (v, d) => `${value(v, d)}${NBSP}${label}`,
    signed: (v, d) => {
      const body = value(Math.abs(v), d);
      return `${v < 0 ? MINUS : "+"}${body}`;
    },
  };
}

/** Jämna gränsvärden för stegskalor, t.ex. max 41 → [10, 20, 30, 40]. */
export function niceThresholds(max: number, steps = 4): number[] {
  if (!(max > 0)) return [1];
  // Största jämna steg där översta gränsen fortfarande ligger under max,
  // så att toppsteget ("40+") aldrig blir tomt.
  const raw = max / steps;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const step = (n >= 5 ? 5 : n >= 2.5 ? 2.5 : n >= 2 ? 2 : 1) * pow;
  return Array.from({ length: steps }, (_, i) => Math.round(step * (i + 1) * 1e6) / 1e6);
}
