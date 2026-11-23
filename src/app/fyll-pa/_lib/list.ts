/**
 * Listan i Fyll på (V2, uppgradering 3): automaterna som bilden av den riktiga automaten
 * (MachineGlyph) med facken på skärmen. Rena funktioner (testas i list.test.ts); sidan
 * (fill-list.tsx) ritar dem. Bara antal, aldrig belopp.
 *
 * - Grupperna: de som behöver påfyllning (stora kort, i behovsordning), de med okänd nivå
 *   (ingen Awish-läsning och inget att fylla, en kort rad) och resten, som är fulla (en
 *   hopfälld rad "Allt fullt · N automater").
 * - Skärmen: ett fack per titel i automatens fackordning, fyllnad = nu ÷ kapacitet (okänd utan
 *   kapacitet), tomt = slut eller tomma fack.
 * - Kortets packbilder: titlarna som ska fyllas (det automaten vill ha, eller slut), med "+N".
 * - Kvittot efter Klar: de påfyllda packen per titel, tiden vid automaten och nästa stopp.
 */

import type { GlyphSlot, GlyphStatus } from "@/components/v2/machine-glyph-model";
import { formatInt, NBSP } from "@/lib/format";

import { bringList, packsWanted, type FillMachine, type FillRow } from "./model";
import { inSlotOrder, type MachineLink } from "./tiles";

export interface ListGroups {
  /** Behöver påfyllning, i behovsordning (som listan förut). */
  readonly need: FillMachine[];
  /** Okänd nivå: ingen känd kapacitet och inget att fylla. */
  readonly unknown: FillMachine[];
  /** Inget att fylla och känd nivå. */
  readonly full: FillMachine[];
}

export function listGroups(machines: readonly FillMachine[]): ListGroups {
  const need: FillMachine[] = [];
  const unknown: FillMachine[] = [];
  const full: FillMachine[] = [];
  for (const m of machines) {
    if (m.needs) need.push(m);
    else if (m.fillPct === null) unknown.push(m);
    else full.push(m);
  }
  return { need, unknown, full };
}

/** Facket på skärmen för en rad: fyllnad (null = okänd) och tomt. */
export function glyphSlotOf(
  r: Pick<FillRow, "name" | "now" | "capacity" | "status" | "emptySlots">,
): GlyphSlot {
  const fill =
    r.capacity !== null && r.capacity > 0
      ? Math.max(0, Math.min(1, Math.max(0, r.now) / r.capacity))
      : null;
  return { title: r.name, fill, empty: r.status === "empty" || r.emptySlots > 0 };
}

/** Skärmens fack i automatens fackordning. */
export function glyphSlotsOf(m: Pick<FillMachine, "rows" | "slots">): GlyphSlot[] {
  return inSlotOrder(m.rows, m.slots).map(glyphSlotOf);
}

/** Bildens läge: offline, tom (slut eller tomma fack), fyll på, annars ok. */
export function glyphStatusFor(
  m: Pick<FillMachine, "empty" | "emptySlots" | "needs">,
  link: MachineLink | null | undefined,
): GlyphStatus {
  if (link === "offline") return "offline";
  if (m.empty > 0 || m.emptySlots > 0) return "empty";
  if (m.needs) return "refill";
  return "ok";
}

/** En titel att fylla på kortet: packbilden med "+N" (0 = slut men antalet okänt). */
export interface FillPack {
  readonly titleId: string;
  readonly name: string;
  readonly want: number;
  /** Slut eller tomma fack (röd ram). */
  readonly empty: boolean;
}

/** Titlarna som ska fyllas: det automaten vill ha (utan tak från lagret), eller slut. */
export function fillPacks(m: Pick<FillMachine, "rows">): FillPack[] {
  const out: FillPack[] = [];
  for (const r of m.rows) {
    const want = packsWanted(r);
    const empty = r.status === "empty" || r.emptySlots > 0;
    if (want <= 0 && !empty) continue;
    out.push({ titleId: r.titleId, name: r.name, want, empty });
  }
  // Slut först, sedan flest pack (raderna är redan i behovsordning; stabil sortering).
  return out.sort((a, b) => Number(b.empty) - Number(a.empty) || b.want - a.want);
}

export const titlar = (n: number): string =>
  `${formatInt(n)}${NBSP}${n === 1 ? "titel" : "titlar"}`;

/** "Fyll 3 titlar" och "43 pack" (null utan känt antal). */
export function fillAction(packs: readonly FillPack[]): { label: string; packs: string | null } {
  const n = packs.reduce((s, p) => s + p.want, 0);
  return {
    label: `Fyll ${titlar(packs.length)}`,
    packs: n > 0 ? `${formatInt(n)}${NBSP}pack` : null,
  };
}

/** Märket på kortet: "Offline", "2 slut", "3 tomma platser", "1 snart slut" eller inget. */
export function cardChip(
  m: Pick<FillMachine, "empty" | "emptySlots" | "low">,
  link: MachineLink | null | undefined,
): { tone: "critical" | "warning" | "neutral"; text: string } | null {
  if (link === "offline") return { tone: "critical", text: "Offline" };
  if (m.empty > 0) return { tone: "critical", text: `${formatInt(m.empty)}${NBSP}slut` };
  if (m.emptySlots > 0) {
    return {
      tone: "critical",
      text: `${formatInt(m.emptySlots)}${NBSP}${m.emptySlots === 1 ? "tom plats" : "tomma platser"}`,
    };
  }
  if (m.low > 0) return { tone: "warning", text: `${formatInt(m.low)}${NBSP}snart slut` };
  if (link === "power_off") return { tone: "neutral", text: "Strömmen av" };
  return null;
}

/** Ta med: pack per titel för automaterna som behöver påfyllning (flest först). */
export function bringStrip(need: readonly FillMachine[]): {
  items: { titleId: string; name: string; want: number }[];
  total: number;
} {
  const list = bringList(need, new Set(need.map((m) => m.id)), null);
  const items = list.totals
    .filter((t) => t.want > 0)
    .map((t) => ({ titleId: t.titleId, name: t.name, want: t.want }))
    .sort((a, b) => b.want - a.want || a.name.localeCompare(b.name, "sv"));
  return { items, total: list.want };
}

// ---------------------------------------------------------------------------
// Kvittot efter Klar
// ---------------------------------------------------------------------------

/** Längre än så här vid automaten räknas inte (sidan låg öppen): tiden visas inte. */
export const MAX_MINUTES = 180;

/** Minuter vid automaten (minst 1), null när tiden saknas eller är orimlig. */
export function minutesAt(openedAt: number | null | undefined, doneAt: number): number | null {
  if (openedAt === null || openedAt === undefined || !Number.isFinite(openedAt)) return null;
  const ms = doneAt - openedAt;
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.max(1, Math.round(ms / 60_000));
  return min > MAX_MINUTES ? null : min;
}

/** De påfyllda packen per titel (flest först), ur raderna som skickades. */
export function receiptItems(
  lines: readonly { row: Pick<FillRow, "titleId" | "name">; quantity: number }[],
): { titleId: string; name: string; qty: number }[] {
  const by = new Map<string, { titleId: string; name: string; qty: number }>();
  for (const { row, quantity } of lines) {
    const q = Math.max(0, Math.trunc(quantity));
    if (q <= 0) continue;
    const at = by.get(row.titleId);
    if (at) at.qty += q;
    else by.set(row.titleId, { titleId: row.titleId, name: row.name, qty: q });
  }
  return [...by.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, "sv"));
}

/**
 * Nästa automat efter den som just fylldes: ruttens nästa stopp, annars den första i listan
 * som behöver påfyllning (inte den som just fylldes). null = ingen.
 */
export function nextMachineId(args: {
  justFilled: string;
  routeNext?: string | null;
  machines: readonly Pick<FillMachine, "id" | "needs">[];
}): string | null {
  if (args.routeNext) return args.routeNext;
  return args.machines.find((m) => m.needs && m.id !== args.justFilled)?.id ?? null;
}
