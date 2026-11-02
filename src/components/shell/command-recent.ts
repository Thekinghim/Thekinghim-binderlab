/**
 * Kommandopalettens senaste val, sparade lokalt i webbläsaren (localStorage).
 *
 * Nyckeln innehåller organisation, användare och roll, så att en annan roll (t.ex.
 * påfyllaren på samma dator) aldrig ser någon annans val i paletten. Kommandon
 * (sidor och åtgärder) sparas som id och slås upp mot rollens aktuella kommandon;
 * sökträffar sparas med etikett, metadata och länk (ikonen följer av id:t). Bara
 * interna länkar ("/…") godtas när listan läses tillbaka.
 *
 * localStorage kan läsas av vem som helst vid datorn (devtools), så:
 * - Orderträffar sparas utan metadata: inga belopp, ingen tid, ingen automat
 *   (sanitizeRecent, både när listan skrivs och när den läses).
 * - Utloggning tar bort alla sparade listor i webbläsaren (clearAllRecent).
 * - När paletten laddas tas andra användares listor bort, och användarens egna
 *   listor för en annan roll i samma organisation (purgeForeignRecent). Det täcker
 *   en session som gått ut utan utloggning och en användare som fått ny roll.
 */

import type { CarryMode } from "@/server/search/types";

export const RECENT_LIMIT = 5;
const PREFIX = "binderlab-palett-senaste";

export type RecentEntry =
  | { readonly type: "command"; readonly id: string }
  | {
      readonly type: "link";
      readonly id: string;
      readonly label: string;
      readonly code?: string;
      readonly meta: readonly string[];
      readonly href: string;
      readonly carry: CarryMode;
    };

export interface RecentScope {
  readonly organizationId: string;
  readonly user: string;
  readonly role: string;
}

export function recentKey(scope: RecentScope): string {
  return `${PREFIX}:${scope.organizationId}:${scope.user.toLowerCase()}:${scope.role}`;
}

/** Nyckelns delar, eller null om nyckeln inte är palettens. */
export function parseRecentKey(key: string): RecentScope | null {
  if (!key.startsWith(`${PREFIX}:`)) return null;
  const parts = key.slice(PREFIX.length + 1).split(":");
  if (parts.length < 3) return null;
  const organizationId = parts[0]!;
  const role = parts[parts.length - 1]!;
  const user = parts.slice(1, -1).join(":");
  return { organizationId, user, role };
}

/**
 * Sant om en sparad lista ska bort när `current` använder paletten: annan användare,
 * eller samma användare och organisation men en annan roll. Olästa nycklar tas bort.
 */
export function isForeignRecentKey(key: string, current: RecentScope): boolean {
  if (!key.startsWith(`${PREFIX}:`)) return false;
  const k = parseRecentKey(key);
  if (!k) return true;
  if (k.user !== current.user.toLowerCase()) return true;
  return k.organizationId === current.organizationId && k.role !== current.role;
}

/** Sant för en orderträff (id "order:…"). */
function isOrderEntry(id: string): boolean {
  return id.startsWith("order:");
}

/** Posten som den får sparas: orderträffar utan metadata (inga belopp). */
export function sanitizeRecent(entry: RecentEntry): RecentEntry {
  if (entry.type !== "link" || !isOrderEntry(entry.id) || entry.meta.length === 0) return entry;
  return { ...entry, meta: [] };
}

/** Sant för en intern sökväg ("/order?…"), aldrig "//värd" eller ett schema. */
export function isInternalHref(href: unknown): href is string {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//");
}

const CARRY: readonly CarryMode[] = ["all", "period", "none"];

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 4) : [];
}

/** Tolkar sparad data. Allt som inte ser ut som en post kastas. */
export function parseRecent(raw: string | null): RecentEntry[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: RecentEntry[] = [];
  for (const e of data) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) continue;
    if (r.type === "command") out.push({ type: "command", id: r.id });
    else if (r.type === "link" && typeof r.label === "string" && isInternalHref(r.href)) {
      out.push({
        type: "link",
        id: r.id,
        label: r.label.slice(0, 200),
        code: typeof r.code === "string" ? r.code.slice(0, 40) : undefined,
        meta: isOrderEntry(r.id) ? [] : strings(r.meta),
        href: r.href,
        carry: CARRY.includes(r.carry as CarryMode) ? (r.carry as CarryMode) : "none",
      });
    }
    if (out.length === RECENT_LIMIT) break;
  }
  return out;
}

/** Lägger posten först och tar bort dubbletter (samma id). */
export function pushRecent(list: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)]
    .slice(0, RECENT_LIMIT)
    .map(sanitizeRecent);
}

export function readRecent(key: string): RecentEntry[] {
  try {
    return parseRecent(window.localStorage.getItem(key));
  } catch {
    return [];
  }
}

export function writeRecent(key: string, list: readonly RecentEntry[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(list.map(sanitizeRecent)));
  } catch {
    /* privat läge eller fullt: valen sparas inte */
  }
}

/** Palettens nycklar i localStorage just nu. */
function storedKeys(): string[] {
  const keys: string[] = [];
  const storage = window.localStorage;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(`${PREFIX}:`)) keys.push(key);
  }
  return keys;
}

/** Tar bort andra användares listor och användarens listor för en annan roll. */
export function purgeForeignRecent(current: RecentScope): void {
  try {
    for (const key of storedKeys()) {
      if (isForeignRecentKey(key, current)) window.localStorage.removeItem(key);
    }
  } catch {
    /* lagringen går inte att läsa: inget att rensa */
  }
}

/** Tar bort alla palettens listor i webbläsaren (vid utloggning). */
export function clearAllRecent(): void {
  try {
    for (const key of storedKeys()) window.localStorage.removeItem(key);
  } catch {
    /* lagringen går inte att läsa: inget att rensa */
  }
}
