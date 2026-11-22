/**
 * Automatens historik i V2 (Automater → Historik, byggplanen 2.3). Ren funktion: raderna
 * läses av ./history.ts. Inga belopp: historiken visas för alla roller, också påfyllaren.
 *
 *   Påfylld        stock_events refill/transfer_in på automatens plats, per minut och person
 *                  (en påfyllning i Fyll på blir en rad: "23 pack · 2 titlar")
 *   Inventering    stock_events count från appen (source null) på automatens plats
 *   Produktbyte    product_swaps ("Fack A2: Black Bolt → Surging Sparks")
 *   Offline        alerts machine_offline
 *   Installerad    machine_placements (placeringens första dag, butikens namn)
 *
 * Prisändringar visas inte (ingen prishistorik per automat, byggplanen avsnitt 7).
 */

export type HistoryKind = "fill" | "count" | "swap" | "offline" | "placed";

export interface HistoryEntry {
  readonly kind: HistoryKind;
  /** ISO-tid (sorteringen, nyast först). */
  readonly at: string;
  /** "Påfylld av Kim", "Inventering", "Produktbyte · Fack A2", "Offline", "Installerad". */
  readonly title: string;
  /** "23 pack · 2 titlar" osv. */
  readonly detail: string;
  /** Varning (röd rubrik i prototypen): offline. */
  readonly alert?: boolean;
}

export interface HistoryInput {
  readonly fills: readonly {
    readonly at: string;
    readonly who: string | null;
    readonly packs: number;
    readonly titles: number;
  }[];
  readonly counts: readonly { readonly at: string; readonly titles: number }[];
  readonly swaps: readonly {
    readonly at: string;
    readonly channel: string;
    readonly from: string;
    readonly to: string;
    readonly returned: number;
    readonly taken: number;
  }[];
  readonly offline: readonly { readonly at: string; readonly message: string | null }[];
  readonly placements: readonly { readonly from: string; readonly storeName: string }[];
}

/** Högst så många rader (nyast först). */
export const HISTORY_LIMIT = 40;

const packs = (n: number) => `${n} ${n === 1 ? "pack" : "pack"}`;
const titles = (n: number) => `${n} ${n === 1 ? "titel" : "titlar"}`;

/** Historiken, nyast först. */
export function buildHistory(input: HistoryInput, limit = HISTORY_LIMIT): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const f of input.fills) {
    if (f.packs <= 0) continue;
    out.push({
      kind: "fill",
      at: f.at,
      title: f.who ? `Påfylld av ${f.who}` : "Påfylld",
      detail: `${packs(f.packs)} · ${titles(f.titles)}`,
    });
  }
  for (const c of input.counts) {
    out.push({
      kind: "count",
      at: c.at,
      title: "Inventering",
      detail: `${titles(c.titles)} räknade`,
    });
  }
  for (const w of input.swaps) {
    const moved = [
      w.returned > 0 ? `${packs(w.returned)} tillbaka till lagret` : null,
      w.taken > 0 ? `${packs(w.taken)} ur lagret` : null,
    ].filter(Boolean);
    out.push({
      kind: "swap",
      at: w.at,
      title: `Produktbyte · Fack ${w.channel}`,
      detail: `${w.from} → ${w.to}${moved.length > 0 ? ` · ${moved.join(", ")}` : ""}`,
    });
  }
  for (const o of input.offline) {
    out.push({
      kind: "offline",
      at: o.at,
      title: "Offline",
      detail: o.message?.trim() || "Automaten slutade svara.",
      alert: true,
    });
  }
  for (const p of input.placements) {
    out.push({
      kind: "placed",
      at: `${p.from}T00:00:00.000Z`,
      title: "Installerad",
      detail: `Start · ${p.storeName}`,
    });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, Math.max(0, limit));
}
