/**
 * Fyllnadsgrad per automat: hur fulla facken är, från kapaciteten i Awish
 * (machine_slot_capacity) och saldot i automaten. Rena funktioner utan I/O.
 *
 *   pack      = Σ min(saldo, kapacitet) över titlarna med kapacitet
 *   kapacitet = Σ kapacitet
 *   bp        = pack × 10 000 / kapacitet (avrundat halvt uppåt)
 *
 * En titel med saldo 0 är en slutsåld uppsättning fack. En automat utan kapacitetsrader
 * har ingen fyllnadsgrad (null, inte 0).
 */

import { roundHalfUp } from "@/domain";

import type { MachineCapacity } from "./types";

/** Fyllnadsgraden för en automat. */
export interface FillLevel {
  readonly units: number;
  readonly capacity: number;
  /** Andel fylld i baspunkter (10 000 = full). */
  readonly bp: number;
  /** Fack i titlar som är slut (minst 1 per titel). */
  readonly emptyChannels: number;
  /** Titlar som är slut. */
  readonly emptyTitles: number;
}

/** Fyllnadsgraden per automat. Automater utan kapacitet saknas i kartan. */
export function fillLevels(
  capacities: readonly MachineCapacity[],
  stock: readonly {
    readonly machineId: string;
    readonly titleId: string;
    readonly onHand: number;
  }[],
): Map<string, FillLevel> {
  const onHand = new Map<string, number>();
  for (const s of stock) {
    const k = `${s.machineId}\u0000${s.titleId}`;
    onHand.set(k, (onHand.get(k) ?? 0) + s.onHand);
  }
  const acc = new Map<
    string,
    { units: number; capacity: number; emptyChannels: number; emptyTitles: number }
  >();
  for (const c of capacities) {
    if (!Number.isSafeInteger(c.capacity) || c.capacity <= 0) continue;
    const have = Math.max(0, onHand.get(`${c.machineId}\u0000${c.titleId}`) ?? 0);
    const cur = acc.get(c.machineId) ?? { units: 0, capacity: 0, emptyChannels: 0, emptyTitles: 0 };
    cur.units += Math.min(have, c.capacity);
    cur.capacity += c.capacity;
    if (have === 0) {
      cur.emptyTitles += 1;
      cur.emptyChannels += Math.max(1, c.channels?.length ?? 0);
    }
    acc.set(c.machineId, cur);
  }
  const out = new Map<string, FillLevel>();
  for (const [machineId, a] of acc) {
    out.set(machineId, { ...a, bp: roundHalfUp(a.units * 10_000, a.capacity) });
  }
  return out;
}

/** Fyllnadsgraden för en automat, eller null utan kapacitet. */
export function fillLevelOf(
  levels: ReadonlyMap<string, FillLevel>,
  machineId: string,
): FillLevel | null {
  return levels.get(machineId) ?? null;
}

/** Ton för fyllnadsgraden: under 30 % röd, under 60 % gul, annars grön. */
export function fillTone(bp: number): "critical" | "warning" | "ok" {
  if (bp < 3_000) return "critical";
  if (bp < 6_000) return "warning";
  return "ok";
}

/** Hela procent, avrundat halvt uppåt (6 667 bp → 67). */
export function fillPercent(bp: number): number {
  return roundHalfUp(Math.max(0, Math.trunc(bp)), 100);
}

const CHANNEL = /^(.*?)(\d+)$/;

/** Jämför kanalnamn som Awish-synken: "A2" före "A10". */
export function compareChannels(a: string, b: string): number {
  return a.localeCompare(b, "sv", { numeric: true, sensitivity: "base" });
}

/**
 * Kanalerna som kort text: sorterade, tre eller fler i följd slås ihop
 * ("A3", "A4", "A5", "B1" → "A3–A5 B1"; "A3", "A4" → "A3 A4").
 */
export function channelText(channels: readonly string[]): string {
  const sorted = [...new Set(channels.map((c) => c.trim()).filter((c) => c !== ""))].sort(
    compareChannels,
  );
  const parts: string[] = [];
  let run: { prefix: string; from: number; to: number; names: string[] } | null = null;
  const flush = () => {
    if (!run) return;
    if (run.names.length >= 3) parts.push(`${run.names[0]}–${run.names[run.names.length - 1]}`);
    else parts.push(...run.names);
    run = null;
  };
  for (const c of sorted) {
    const m = CHANNEL.exec(c);
    if (!m) {
      flush();
      parts.push(c);
      continue;
    }
    const prefix = m[1]!.toUpperCase();
    const n = Number.parseInt(m[2]!, 10);
    if (run && run.prefix === prefix && n === run.to + 1) {
      run.to = n;
      run.names.push(c);
    } else {
      flush();
      run = { prefix, from: n, to: n, names: [c] };
    }
  }
  flush();
  return parts.join(" ");
}
