/**
 * Inventering (räkna ett helt eget lager): rena funktioner och typer, klientsäkert.
 *
 * - Utkastet: det man hunnit räkna sparas på telefonen (localStorage) per lager, så att en
 *   halvfärdig inventering finns kvar om appen stängs. Ett tomt fält = produkten hoppas
 *   över och ändras inte.
 * - Sammanfattningen: vad som ändras ("Paldea: 162 → 0"), vad som stämde och vad som
 *   hoppades över.
 * - Lagren med "Senast inventerad" (gränsen 30 dagar räknas i @/analytics/todos/stock-count,
 *   samma regel som punkten i Att göra).
 */

import { MAX_PACKS } from "../../../lager/_lib/schemas";

/** Högst så många produkter i en inventering (samma gräns som i databasen). */
export const MAX_COUNT_LINES = 500;

/** Ett eget lager på inventeringssidan. */
export interface CountPlace {
  readonly id: string;
  readonly name: string;
  /** Senaste sparade inventeringen (ISO 8601), eller null om lagret aldrig inventerats. */
  readonly lastCountedAt: string | null;
  /** Hela dagar sedan dess (affärsdatum), eller null. */
  readonly daysSince: number | null;
  /** Inte inventerat på 30 dagar (eller aldrig, och lagret är äldre än så). */
  readonly overdue: boolean;
}

/** En produkt att räkna. */
export interface CountRow {
  readonly titleId: string;
  readonly name: string;
  /** Vad appen tror per lager (lagrets id → pack; saknas = 0). */
  readonly byPlace: Readonly<Record<string, number>>;
}

export type CountMode = "step" | "list";

/** Utkastet för ett lager. `counts` är det man skrivit (text), per titel. */
export interface CountDraft {
  /** Inskickets id: samma utkast sparas bara en gång även om man trycker två gånger. */
  readonly clientId: string;
  readonly counts: Readonly<Record<string, string>>;
  /**
   * Vad appen trodde om titeln när antalet skrevs. Ändras lagret medan man räknar (en
   * påfyllning, en leverans) pekas raden ut innan man sparar. Saknas i äldre utkast.
   */
  readonly seen?: Readonly<Record<string, number>>;
  readonly mode: CountMode;
  /** Vilken produkt man står på i "En i taget". */
  readonly index: number;
  readonly updatedAt: string;
}

/** Alla utkast: lagrets id → utkast. */
export type CountDrafts = Readonly<Record<string, CountDraft>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDraft(v: unknown): v is CountDraft {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.clientId === "string" &&
    UUID.test(d.clientId) &&
    typeof d.counts === "object" &&
    d.counts !== null &&
    Object.entries(d.counts as Record<string, unknown>).every(
      ([k, x]) => UUID.test(k) && typeof x === "string" && x.length <= 12,
    ) &&
    (d.seen === undefined ||
      (typeof d.seen === "object" &&
        d.seen !== null &&
        Object.entries(d.seen as Record<string, unknown>).every(
          ([k, x]) => UUID.test(k) && typeof x === "number" && Number.isInteger(x),
        ))) &&
    (d.mode === "step" || d.mode === "list") &&
    typeof d.index === "number" &&
    Number.isInteger(d.index) &&
    d.index >= 0 &&
    typeof d.updatedAt === "string"
  );
}

/** Läser utkasten ur lagringen. Trasig eller okänd text ger inga utkast (aldrig ett fel). */
export function parseDrafts(raw: string | null): CountDrafts {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, CountDraft> = {};
    for (const [placeId, draft] of Object.entries(parsed as Record<string, unknown>)) {
      if (UUID.test(placeId) && isDraft(draft)) out[placeId] = draft;
    }
    return out;
  } catch {
    return {};
  }
}

export function newDraft(clientId: string, now: Date, mode: CountMode = "step"): CountDraft {
  return { clientId, counts: {}, mode, index: 0, updatedAt: now.toISOString() };
}

/**
 * Utkastet med ett nytt värde för en titel. Tom text tar bort titeln (hoppas över).
 * `expected` är vad appen tror just nu (sparas som "seen"). `clientId` är ett nytt
 * inskicks-id som tas i bruk när antalet faktiskt ändras: ett sparat inskick som man
 * sedan ändrar och skickar igen ska sparas, inte besvaras med "redan sparad".
 */
export function withCount(
  draft: CountDraft,
  titleId: string,
  text: string,
  now: Date,
  opts: { readonly expected?: number; readonly clientId?: string } = {},
): CountDraft {
  const counts = { ...draft.counts };
  const seen = { ...draft.seen };
  const clean = text.replace(/[^\d]/g, "").slice(0, 6);
  const changed = (draft.counts[titleId] ?? "") !== clean;
  if (clean === "") {
    delete counts[titleId];
    delete seen[titleId];
  } else {
    counts[titleId] = clean;
    if (opts.expected !== undefined) seen[titleId] = opts.expected;
  }
  return {
    ...draft,
    clientId: changed && opts.clientId ? opts.clientId : draft.clientId,
    counts,
    ...(Object.keys(seen).length > 0 || draft.seen !== undefined ? { seen } : {}),
    updatedAt: now.toISOString(),
  };
}

export type ParsedCount =
  { readonly ok: true; readonly n: number } | { readonly ok: false; readonly error: "min" | "max" };

/** Ett räknat antal: heltal 0–10 000. */
export function parseCount(text: string): ParsedCount {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { ok: false, error: "min" };
  const n = Number(t);
  if (n > MAX_PACKS) return { ok: false, error: "max" };
  return { ok: true, n };
}

export interface CountLine {
  readonly titleId: string;
  readonly name: string;
  /** Vad appen trodde. */
  readonly previous: number;
  /** Vad som räknades. */
  readonly counted: number;
}

export interface CountSummary {
  /** Alla räknade produkter, i listans ordning (det som skickas in). */
  readonly lines: readonly CountLine[];
  /** De som ändrar saldot. */
  readonly changed: readonly CountLine[];
  /** Räknade som stämde med appen. */
  readonly same: number;
  /** Inte räknade: ändras inte. */
  readonly skipped: number;
  /** Titlar med ett ogiltigt antal (över 10 000). */
  readonly invalid: readonly string[];
  /**
   * Rader där lagret ändrades efter att antalet skrevs (och det räknade inte stämmer med
   * appen nu): räkna dem en gång till.
   */
  readonly stale: readonly StaleLine[];
}

export interface StaleLine extends CountLine {
  /** Vad appen trodde när antalet skrevs. */
  readonly seen: number;
}

/**
 * Sammanfattar utkastet mot listan. Titlar i utkastet som inte längre finns i listan
 * (arkiverade eller sammanslagna under tiden) räknas inte.
 */
export function summarize(
  rows: readonly CountRow[],
  placeId: string,
  counts: Readonly<Record<string, string>>,
  seen: Readonly<Record<string, number>> = {},
): CountSummary {
  const lines: CountLine[] = [];
  const invalid: string[] = [];
  let skipped = 0;
  for (const r of rows) {
    const text = counts[r.titleId];
    if (text === undefined || text.trim() === "") {
      skipped += 1;
      continue;
    }
    const parsed = parseCount(text);
    if (!parsed.ok) {
      invalid.push(r.titleId);
      continue;
    }
    lines.push({
      titleId: r.titleId,
      name: r.name,
      previous: r.byPlace[placeId] ?? 0,
      counted: parsed.n,
    });
  }
  const changed = lines.filter((l) => l.previous !== l.counted);
  const stale = changed.flatMap((l) => {
    const was = seen[l.titleId];
    return was !== undefined && was !== l.previous ? [{ ...l, seen: was }] : [];
  });
  return { lines, changed, same: lines.length - changed.length, skipped, invalid, stale };
}

/** Antal produkter med något ifyllt (för "Fortsätt · 5 räknade"). */
export function countedCount(rows: readonly CountRow[], draft: CountDraft | undefined): number {
  if (!draft) return 0;
  return rows.filter((r) => (draft.counts[r.titleId] ?? "").trim() !== "").length;
}
