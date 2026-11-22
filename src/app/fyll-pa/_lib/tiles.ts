/**
 * Fyll på som rutor (V2, ägarens val A): ett fack per ruta i automatens fackordning. Rena
 * funktioner (testas i tiles.test.ts); sidan (fill-app.tsx, fill-v2.tsx) ritar dem.
 *
 * - Allt börjar på 0: inget är förvalt (`initialSelection`).
 * - Ett tryck på en ruta som inte är vald fyller facket (`tapQty`): samma antal som förslaget
 *   (kapacitet − nu, högst packen i lagret man fyller från; mystery packs en hel omgång när
 *   facket är tomt och lagret har en). Utan eget lager: kapacitet − nu utan tak från lagret.
 *   Går inget att fylla (fullt, inget i lagret, mystery-facket har pack) öppnas arket i
 *   stället, där stegaren, varningarna och "Fel antal i automaten?" finns.
 * - Ett tryck på en vald ruta öppnar arket (`tapTile`).
 * - Stegaren i arket går från 0 till `maxFill` (samma tak som förut).
 * - Listan: "Ta med N pack" (det automaten vill ha, utan tak från lagret), upp till sex packbilder
 *   för titlar som är slut eller snart slut, och ett märke (Offline, Slut, Fyll på i dag).
 */

import { maxFill, packsWanted, type FillMachine, type FillRow } from "./model";

/** Valt antal per titel (titelns id → pack). Saknas = 0. */
export type Selection = Readonly<Record<string, number>>;

/** Valet när automaten öppnas: tomt (allt börjar på 0, inga förifyllda förslag). */
export function initialSelection(): Selection {
  return {};
}

type TapRow = Pick<FillRow, "now" | "capacity" | "sold" | "suggested"> &
  Partial<Pick<FillRow, "batchSize">>;

/**
 * Antalet ett tryck väljer för en ruta som inte är vald; 0 = inget att fylla (arket öppnas).
 * `hasSource`: det finns ett eget lager att ta packen från (då gäller lagrets saldo som tak).
 */
export function tapQty(row: TapRow, hasSource: boolean): number {
  const q = hasSource ? row.suggested : packsWanted(row);
  return Math.max(0, Math.min(Math.trunc(q), maxFill(row)));
}

/**
 * Ett tryck på en ruta: vald (antal > 0) → arket öppnas; annars fylls facket, eller öppnas
 * arket när inget går att fylla.
 */
export function tapTile(
  selection: Selection,
  row: TapRow & Pick<FillRow, "titleId">,
  hasSource: boolean,
): { selection: Selection; sheet: boolean } {
  if ((selection[row.titleId] ?? 0) > 0) return { selection, sheet: true };
  const q = tapQty(row, hasSource);
  if (q <= 0) return { selection, sheet: true };
  return { selection: { ...selection, [row.titleId]: q }, sheet: false };
}

/** Stegarens gränser i arket: 0 till samma tak som förut (`maxFill`). */
export function stepperBounds(
  row: Pick<FillRow, "now" | "capacity"> & Partial<Pick<FillRow, "batchSize">>,
): {
  min: number;
  max: number;
} {
  return { min: 0, max: maxFill(row) };
}

/** Valet med ett nytt antal för en titel, inom stegarens gränser ("Töm" = 0). */
export function setQty(
  selection: Selection,
  row: Pick<FillRow, "titleId" | "now" | "capacity"> & Partial<Pick<FillRow, "batchSize">>,
  value: number,
): Selection {
  const { min, max } = stepperBounds(row);
  const v = Math.max(min, Math.min(max, Math.trunc(value) || 0));
  return { ...selection, [row.titleId]: v };
}

/** Rutorna i automatens fackordning; titlar utan fack sist, i radernas ordning. */
export function inSlotOrder<R extends Pick<FillRow, "titleId">>(
  rows: readonly R[],
  slots: readonly string[] | undefined,
): R[] {
  if (!slots || slots.length === 0) return [...rows];
  const at = new Map(slots.map((id, i) => [id, i]));
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const sa = at.get(a.r.titleId) ?? slots.length + a.i;
      const sb = at.get(b.r.titleId) ?? slots.length + b.i;
      return sa - sb;
    })
    .map((x) => x.r);
}

/** Det rutan visar. */
export interface TileView {
  /** Pack i automaten efter påfyllningen (nu + valt). */
  readonly shown: number;
  readonly capacity: number | null;
  /** Andelen av kapaciteten nu och efter (0–1); 0 utan känd kapacitet. */
  readonly nowShare: number;
  readonly shownShare: number;
  /** Fullt efter påfyllningen (grön stapel). */
  readonly full: boolean;
  /** "Slut": facket är tomt och inget är valt (bilden bleks). */
  readonly out: boolean;
}

export function tileView(row: Pick<FillRow, "now" | "capacity">, value: number): TileView {
  const now = Math.max(0, row.now);
  const shown = now + Math.max(0, value);
  const cap = row.capacity;
  const share = (n: number) => (cap !== null && cap > 0 ? Math.min(1, n / cap) : 0);
  return {
    shown,
    capacity: cap,
    nowShare: share(now),
    shownShare: share(shown),
    full: cap !== null && cap > 0 && shown >= cap,
    out: now === 0 && value <= 0,
  };
}

// ---------------------------------------------------------------------------
// Listan med automater
// ---------------------------------------------------------------------------

/** "Ta med N pack": det automaten vill ha för att bli full (utan tak från lagret). */
export function bringCount(m: Pick<FillMachine, "rows">): number {
  return m.rows.reduce((n, r) => n + packsWanted(r), 0);
}

/**
 * Packbilderna på kortet: titlar som är slut (eller har tomma fack) först, sedan snart slut,
 * högst `max`. `empty` = slut (bilden bleks).
 */
export function urgentPacks(
  m: Pick<FillMachine, "rows">,
  max = 6,
): { titleId: string; name: string; empty: boolean }[] {
  const out = m.rows.filter((r) => r.status === "empty" || r.emptySlots > 0);
  const low = m.rows.filter((r) => r.status === "low" && r.emptySlots === 0);
  return [...out, ...low].slice(0, max).map((r) => ({
    titleId: r.titleId,
    name: r.name,
    empty: r.status === "empty" || r.now <= 0,
  }));
}

/** Automatens läge utanför Binderlab (maskinhälsan): offline, eller strömmen av just nu. */
export type MachineLink = "offline" | "power_off";

/** Gränsen för "Fyll på i dag" (samma som flottans läge: 25 % eller lägre). */
export const LOW_FILL_PCT = 25;

/** Märket på kortet: Offline, Slut, Fyll på i dag, Strömmen av, eller inget. */
export function listChip(
  m: Pick<FillMachine, "empty" | "emptySlots" | "low" | "fillPct">,
  link: MachineLink | null | undefined,
): { tone: "critical" | "warning" | "neutral"; text: string } | null {
  if (link === "offline") return { tone: "critical", text: "Offline" };
  if (m.empty > 0 || m.emptySlots > 0) return { tone: "critical", text: "Slut" };
  if (m.low > 0 || (m.fillPct !== null && m.fillPct <= LOW_FILL_PCT)) {
    return { tone: "warning", text: "Fyll på i dag" };
  }
  if (link === "power_off") return { tone: "neutral", text: "Strömmen av" };
  return null;
}
