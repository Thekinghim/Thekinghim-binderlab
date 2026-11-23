/**
 * Ren logik för MachineGlyph (bilden av automaten): storlekar, status och vad skärmen visar.
 * Ingen React här, så att reglerna kan testas.
 *
 * Våra automater är smala kiosker med en stor stående pekskärm. Packen syns inte utifrån,
 * så lagret visas PÅ skärmen: ett litet rutnät med automatens packbilder (Awish-facken) och
 * en fyllnadsstapel under varje. Tomt fack = grå bild med röd kant. Offline = släckt skärm.
 * I de minsta storlekarna (≤ 40 px) är skärmen bara en färg.
 */

import type { AwishFillRow, FleetStatus } from "@/analytics/fleet-status";
import { MACHINE_LOOK_LABEL, type MachineLook } from "@/lib/machine-look";

/** Höjd i px. Bredden följer kioskens form (100 : 280). */
export const GLYPH_HEIGHT = { xs: 28, s: 40, m: 96, l: 160, xl: 240 } as const;
export type GlyphSize = keyof typeof GLYPH_HEIGHT;

/** Ritytans mått (viewBox). */
export const GLYPH_VIEW_W = 100;
export const GLYPH_VIEW_H = 280;

export function glyphWidth(size: GlyphSize): number {
  return Math.round((GLYPH_HEIGHT[size] * GLYPH_VIEW_W) / GLYPH_VIEW_H);
}

/** Så små att skärmen bara är en färg (inga packbilder, inget ordmärke). */
export function isTinyGlyph(size: GlyphSize): boolean {
  return GLYPH_HEIGHT[size] <= 40;
}

export type GlyphStatus = "ok" | "refill" | "empty" | "offline";

/** Ett fack (eller en titel) på skärmen. */
export interface GlyphSlot {
  /** Titelns namn (packbilden hittas via packKey). */
  readonly title: string;
  /** Fyllnad 0–1. null = okänd. */
  readonly fill: number | null;
  /** Minst ett tomt fack för titeln. */
  readonly empty?: boolean;
}

/** Flottans läge → bildens läge. Startklar, ström av, tom snart och i drift = ok. */
export function glyphStatusOf(status: FleetStatus): GlyphStatus {
  switch (status) {
    case "offline":
      return "offline";
    case "tom":
      return "empty";
    case "fyll-pa":
      return "refill";
    default:
      return "ok";
  }
}

/**
 * Awish-facken (en rad per titel) → skärmens fack. Fyllnad = pack ÷ kapacitet; tom när
 * något fack för titeln är tomt eller inga pack finns. Titeln saknas i namnlistan = hoppas över.
 * Ordningen behålls.
 */
export function slotsFromFill(
  rows: readonly AwishFillRow[] | null | undefined,
  titleName: (titleId: string) => string | null | undefined,
): GlyphSlot[] {
  if (!rows) return [];
  const out: GlyphSlot[] = [];
  for (const r of rows) {
    const title = titleName(r.title_id)?.trim();
    if (!title) continue;
    const fill = r.capacity > 0 ? clamp01(r.units / r.capacity) : null;
    out.push({ title, fill, empty: r.empty > 0 || r.units <= 0 });
  }
  return out;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Fyllnaden som stapelns ton: tom, låg (≤ 25 %, som Fyll på i dag) eller ok. */
export type CellTone = "empty" | "low" | "ok" | "unknown";

export interface ScreenCell {
  readonly title: string;
  /** 0–1, eller null = okänd. */
  readonly fill: number | null;
  readonly empty: boolean;
  readonly tone: CellTone;
}

export interface ScreenGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cells: readonly ScreenCell[];
  /** Fack som inte får plats ("+3" i sista rutan). 0 = alla syns. */
  readonly more: number;
}

const LOW_FILL = 0.25;

export function cellOf(slot: GlyphSlot): ScreenCell {
  const fill = slot.fill === null || slot.fill === undefined ? null : clamp01(slot.fill);
  const empty = slot.empty === true || fill === 0;
  const tone: CellTone = empty
    ? "empty"
    : fill === null
      ? "unknown"
      : fill <= LOW_FILL
        ? "low"
        : "ok";
  return { title: slot.title, fill: empty ? 0 : fill, empty, tone };
}

/** Största rutnät per storlek (kolumner × rader). */
const MAX_GRID: Readonly<Record<GlyphSize, readonly [number, number]>> = {
  xs: [0, 0],
  s: [0, 0],
  m: [2, 2],
  l: [2, 3],
  xl: [3, 4],
};

/**
 * Skärmens rutnät. Få fack = två kolumner (större bilder); fler än fyra i xl = tre. Får inte
 * alla plats blir sista rutan "+N". Tomma fack sorteras inte om: ordningen är automatens.
 */
export function screenGrid(size: GlyphSize, slots: readonly GlyphSlot[] | undefined): ScreenGrid {
  const [maxCols, maxRows] = MAX_GRID[size];
  const all = (slots ?? []).map(cellOf);
  if (maxCols === 0 || all.length === 0) return { cols: 0, rows: 0, cells: [], more: 0 };
  const cols = all.length <= 4 ? Math.min(2, maxCols) : maxCols;
  const capacity = cols * maxRows;
  const fits = all.length <= capacity;
  const shown = fits ? all : all.slice(0, capacity - 1);
  const more = fits ? 0 : all.length - shown.length;
  const rows = Math.max(1, Math.ceil((shown.length + (more > 0 ? 1 : 0)) / cols));
  return { cols, rows, cells: shown, more };
}

const STATUS_TEXT: Readonly<Record<GlyphStatus, string>> = {
  ok: "I drift",
  refill: "Behöver fyllas på",
  empty: "Tom",
  offline: "Offline",
};

export function glyphStatusText(status: GlyphStatus): string {
  return STATUS_TEXT[status];
}

/**
 * Skärmläsarens text: "BL-001, gul automat. Behöver fyllas på. 6 fack, 2 tomma."
 * Utan namn: "Automat, svart med stjärnor. I drift."
 */
export function glyphAriaLabel(input: {
  readonly look: MachineLook;
  readonly status: GlyphStatus;
  readonly slots?: readonly GlyphSlot[];
  readonly name?: string | null;
}): string {
  const lookText = input.look === "gul" ? "gul automat" : "svart automat med stjärnor";
  const head = input.name?.trim() ? `${input.name.trim()}, ${lookText}` : capitalize(lookText);
  const parts = [`${head}.`, `${STATUS_TEXT[input.status]}.`];
  const slots = input.slots ?? [];
  if (slots.length > 0 && input.status !== "offline") {
    const empty = slots.map(cellOf).filter((c) => c.empty).length;
    const n = slots.length;
    const packs = `${n} ${n === 1 ? "titel" : "titlar"}`;
    parts.push(empty > 0 ? `${packs}, ${empty} ${empty === 1 ? "tom" : "tomma"}.` : `${packs}.`);
  }
  return parts.join(" ");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Etiketten för utseendet ("Svart med stjärnor", "Gul"). */
export function lookLabel(look: MachineLook): string {
  return MACHINE_LOOK_LABEL[look];
}
