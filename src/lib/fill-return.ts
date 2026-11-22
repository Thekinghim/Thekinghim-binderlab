/**
 * Fyll på → tillbaka (V2). Öppnas Fyll på från Hem eller Automater (?fran=hem|automater) går
 * appen tillbaka dit efter Klar, och sidan man kommer till visar notisen "Påfyllt · N pack"
 * med Ångra. Beskedet ligger i sessionStorage (bara den här fliken) i högst en minut; utan
 * sessionStorage (privat läge) stannar Fyll på kvar med sin vanliga bekräftelse.
 */

const KEY = "binderlab:fyll-tillbaka";
/** Ett äldre besked visas inte (sidan laddades om långt senare). */
const MAX_AGE_MS = 60_000;

/** Varifrån Fyll på öppnades och vart Klar går tillbaka. */
const RETURN_TO: Readonly<Record<string, string>> = {
  hem: "/",
  automater: "/automater",
};

/** Adressen att gå tillbaka till för ?fran=, eller null (stanna i Fyll på). */
export function fillReturnTo(from: string | string[] | undefined): string | null {
  const v = Array.isArray(from) ? from[0] : from;
  return v && Object.hasOwn(RETURN_TO, v) ? (RETURN_TO[v] ?? null) : null;
}

export interface FillReturn {
  readonly title: string;
  readonly detail: string;
  readonly packs: number;
  /** Påfyllningarnas klient-id (undoRefills). */
  readonly clientIds: readonly string[];
  readonly at: number;
}

/** Sparar beskedet. false = gick inte (då ska Fyll på inte lämnas). */
export function saveFillReturn(r: Omit<FillReturn, "at">, now = Date.now()): boolean {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ ...r, at: now }));
    return true;
  } catch {
    return false;
  }
}

/** Läser och tar bort beskedet; null om inget finns eller det är för gammalt. */
export function takeFillReturn(now = Date.now()): FillReturn | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(KEY);
    return parseFillReturn(raw, now);
  } catch {
    return null;
  }
}

/** Ren tolkning (testbar): rätt form och inte äldre än en minut. */
export function parseFillReturn(raw: string, now: number): FillReturn | null {
  try {
    const v = JSON.parse(raw) as Partial<FillReturn>;
    if (
      typeof v.title !== "string" ||
      typeof v.detail !== "string" ||
      typeof v.packs !== "number" ||
      typeof v.at !== "number" ||
      !Array.isArray(v.clientIds) ||
      !v.clientIds.every((id) => typeof id === "string")
    ) {
      return null;
    }
    if (now - v.at > MAX_AGE_MS || v.at > now + 5_000) return null;
    return {
      title: v.title,
      detail: v.detail,
      packs: v.packs,
      clientIds: v.clientIds,
      at: v.at,
    };
  } catch {
    return null;
  }
}
