/**
 * Kommandopalettens senaste val, sparade lokalt i webbläsaren (localStorage).
 *
 * Nyckeln innehåller organisation, användare och roll, så att en annan roll (t.ex.
 * påfyllaren på samma dator) aldrig ser någon annans val eller belopp. Kommandon
 * (sidor och åtgärder) sparas som id och slås upp mot rollens aktuella kommandon;
 * sökträffar sparas med etikett, metadata och länk (ikonen följer av id:t). Bara interna länkar ("/…")
 * godtas när listan läses tillbaka.
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

export function recentKey(scope: { organizationId: string; user: string; role: string }): string {
  return `${PREFIX}:${scope.organizationId}:${scope.user.toLowerCase()}:${scope.role}`;
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
        meta: strings(r.meta),
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
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, RECENT_LIMIT);
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
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* privat läge eller fullt: valen sparas inte */
  }
}
