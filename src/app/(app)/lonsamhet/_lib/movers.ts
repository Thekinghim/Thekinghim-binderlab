/**
 * Topplistan med förändring på Lönsamhet: automater, butiker och titlar efter intäkt i
 * perioden, med förändringen mot jämförelseperioden (procent och placering upp/ned).
 *
 * Intäkten är profitabilityViews (samma rader som tabellen på sidan), med order utan
 * inköpspris medräknade, som Hem och tabellens intäkt. Ren funktion utan I/O.
 */

import {
  changeBp,
  profitabilityViews,
  type ProfitabilityInput,
  type ProfitabilityRow,
} from "@/domain";
import { formatDelta, NBSP } from "@/lib/format";

export type MoverKind = "machine" | "store" | "title";
export const MOVER_KINDS: readonly MoverKind[] = ["machine", "store", "title"];

/** Rader i varje lista. */
export const MOVERS_TOP_N = 8;

export interface MoverRow {
  readonly key: string;
  readonly name: string;
  /** Automatens kod ("BL-001"), annars null. */
  readonly code: string | null;
  readonly href: string | null;
  /** Placering i perioden (1 = högst intäkt). */
  readonly rank: number;
  readonly revenueOre: number;
  readonly previousOre: number;
  /** Förändring i bp mot jämförelseperioden, null när den saknas eller var 0. */
  readonly changeBp: number | null;
  /** "+45 %", "Ny", "−12 %" eller null utan jämförelseperiod. */
  readonly changeText: string | null;
  /** Placeringar upp (+) eller ned (−) mot jämförelseperioden; null när den saknas. */
  readonly rankMove: number | null;
  /** Stapelns längd 0–1 mot listans högsta intäkt. */
  readonly bar: number;
}

export interface MoverList {
  readonly kind: MoverKind;
  readonly rows: MoverRow[];
  /** Antal poster med intäkt i perioden (listan visar högst MOVERS_TOP_N). */
  readonly total: number;
  /** Mest upp och mest ned i kronor (bland alla poster), eller null. */
  readonly up: MoverRow | null;
  readonly down: MoverRow | null;
}

export interface MoverNames {
  machine(id: string): { name: string; code: string | null } | null;
  store(id: string): string | null;
  title(id: string): string | null;
}

export interface MoverHrefs {
  machine?(code: string): string;
  store?(id: string): string;
  title?(id: string): string;
}

const revenue = (r: ProfitabilityRow) => r.revenueOre + r.unpricedRevenueOre;

function revenueByKey(rows: readonly ProfitabilityRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) if (r.kind === "item") out.set(r.key, revenue(r));
  return out;
}

/** Placering efter intäkt (högst först, lika: nyckeln), bara poster med intäkt > 0. */
function ranks(byKey: Map<string, number>): Map<string, number> {
  const sorted = [...byKey.entries()]
    .filter(([, ore]) => ore > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return new Map(sorted.map(([key], i) => [key, i + 1]));
}

export function changeText(changeBpValue: number | null, previousOre: number): string {
  if (previousOre <= 0) return "Ny";
  if (changeBpValue === null) return "–";
  const small = changeBpValue !== 0 && Math.abs(changeBpValue) < 1000;
  return formatDelta(changeBpValue / 10_000, small ? 1 : 0);
}

function list(
  kind: MoverKind,
  current: readonly ProfitabilityRow[],
  previous: readonly ProfitabilityRow[] | null,
  names: MoverNames,
  hrefs: MoverHrefs,
): MoverList {
  const cur = revenueByKey(current);
  const prev = previous ? revenueByKey(previous) : null;
  const curRank = ranks(cur);
  const prevRank = prev ? ranks(prev) : null;

  const nameOf = (
    key: string,
  ): { name: string; code: string | null; href: string | null } | null => {
    if (kind === "machine") {
      const m = names.machine(key);
      if (!m) return null;
      return { ...m, href: m.code && hrefs.machine ? hrefs.machine(m.code) : null };
    }
    const name = kind === "store" ? names.store(key) : names.title(key);
    if (!name) return null;
    const href = kind === "store" ? hrefs.store?.(key) : hrefs.title?.(key);
    return { name, code: null, href: href ?? null };
  };

  const rowFor = (key: string, top: number): MoverRow | null => {
    const n = nameOf(key);
    if (!n) return null;
    const ore = cur.get(key) ?? 0;
    const before = prev?.get(key) ?? 0;
    const bp = prev && before > 0 ? changeBp(ore, before) : null;
    const was = prevRank?.get(key) ?? null;
    const now = curRank.get(key) ?? null;
    return {
      key,
      name: n.name,
      code: n.code,
      href: n.href,
      rank: now ?? 0,
      revenueOre: ore,
      previousOre: before,
      changeBp: bp,
      changeText: prev ? changeText(bp, before) : null,
      rankMove: prev && was !== null && now !== null ? was - now : null,
      bar: top > 0 ? Math.max(0, ore) / top : 0,
    };
  };

  const ordered = [...curRank.keys()];
  const top = cur.get(ordered[0] ?? "") ?? 0;
  const rows = ordered
    .map((k) => rowFor(k, top))
    .filter((r): r is MoverRow => r !== null)
    .slice(0, MOVERS_TOP_N);

  let up: MoverRow | null = null;
  let down: MoverRow | null = null;
  if (prev) {
    const keys = new Set([...cur.keys(), ...prev.keys()]);
    let best = 0;
    let worst = 0;
    let upKey: string | null = null;
    let downKey: string | null = null;
    for (const k of [...keys].sort()) {
      const d = (cur.get(k) ?? 0) - (prev.get(k) ?? 0);
      if (d > best) [best, upKey] = [d, k];
      if (d < worst) [worst, downKey] = [d, k];
    }
    up = upKey ? rowFor(upKey, top) : null;
    down = downKey ? rowFor(downKey, top) : null;
  }

  return { kind, rows, total: curRank.size, up, down };
}

/** Topplistorna för perioden mot jämförelseperioden (null = ingen jämförelse). */
export function buildMovers(args: {
  current: ProfitabilityInput;
  previous: ProfitabilityInput | null;
  names: MoverNames;
  hrefs?: MoverHrefs;
}): Record<MoverKind, MoverList> {
  const kinds = ["machine", "store", "title"] as const;
  const cur = profitabilityViews(args.current, kinds, { fillTimeGaps: false });
  // Jämförelseperiod utan försäljning (t.ex. före första ordern) räknas som ingen
  // jämförelse: annars blir allt "Ny" och listan säger ingenting.
  const prev =
    args.previous && args.previous.orders.length > 0
      ? profitabilityViews(args.previous, kinds, { fillTimeGaps: false })
      : null;
  const hrefs = args.hrefs ?? {};
  const rowsOf = (k: MoverKind): readonly ProfitabilityRow[] | null => (prev ? prev[k].rows : null);
  return {
    machine: list("machine", cur.machine.rows, rowsOf("machine"), args.names, hrefs),
    store: list("store", cur.store.rows, rowsOf("store"), args.names, hrefs),
    title: list("title", cur.title.rows, rowsOf("title"), args.names, hrefs),
  };
}

/** "Mest upp: BL-001 Sega gubben +45 %. Mest ned: Ica Nära −30 %." eller null. */
export function moversSummary(l: MoverList): string | null {
  const label = (r: MoverRow) => (r.code ? `${r.code}${NBSP}${r.name}` : r.name);
  const parts: string[] = [];
  if (l.up) parts.push(`Mest upp: ${label(l.up)} ${l.up.changeText ?? ""}`.trim());
  if (l.down) parts.push(`Mest ned: ${label(l.down)} ${l.down.changeText ?? ""}`.trim());
  return parts.length > 0 ? `${parts.join(". ")}.` : null;
}
