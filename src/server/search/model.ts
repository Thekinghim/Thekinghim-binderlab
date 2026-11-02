/**
 * Sökningens regler, utan databas: tolkning av söktexten, träffar i stamdata (titlar,
 * automater, butiker), sökvillkoren för order och hur varje träff visas och vart den
 * leder för en viss roll. Testas i model.test.ts; frågorna ligger i ./queries och
 * flödet (roll, RLS) i ./service.
 *
 * Påfyllaren ser inga belopp och inga order: orderträffar byggs bara för roller som
 * ser ekonomi (canSeeEconomy), och inga andra träffar bär belopp.
 */

import { wallClockIn } from "@/components/shell/period-state";
import type { MemberRole } from "@/db/schema";
import { formatDateTime, formatInt, formatKronor } from "@/lib/format";
import { matchFields, normalize, TIER, type FieldMatch } from "@/lib/fuzzy";
import type { MachineRecord, StoreRecord, TitleRecord } from "@/server/data/core/types";
import { canSeeEconomy } from "@/server/data/core/types";

import {
  HITS_PER_GROUP,
  MAX_SEARCH_LENGTH,
  MAX_SEARCH_TERMS,
  MIN_ORDER_TERM,
  type PickGroup,
  type SearchGroup,
  type SearchHit,
} from "./types";

// ---------------------------------------------------------------------------
// Söktexten
// ---------------------------------------------------------------------------

/** Söktexten som den används: blanktecken ihop, trimmad, högst MAX_SEARCH_LENGTH tecken. */
export function cleanSearch(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_LENGTH).trim();
}

/** Sökorden: unika (utan hänsyn till skiftläge), i ordning, högst MAX_SEARCH_TERMS. */
export function searchTerms(q: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of cleanSearch(q).split(" ")) {
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === MAX_SEARCH_TERMS) break;
  }
  return out;
}

/** LIKE-mönster för "innehåller", med %, _ och \ skyddade. */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Sant om texten ser ut som ett ordernummer (bara siffror, minst tre). */
export function looksLikeOrderNumber(q: string): boolean {
  return /^\d{3,}$/.test(q);
}

// ---------------------------------------------------------------------------
// Stamdata
// ---------------------------------------------------------------------------

/** Stamdata och alias som sökningen behöver. */
export interface SearchMaster {
  readonly titles: readonly TitleRecord[];
  readonly machines: readonly MachineRecord[];
  readonly stores: readonly StoreRecord[];
  /** Titelns alias (originalstavningar från källan). */
  readonly aliases: ReadonlyMap<string, readonly string[]>;
}

/** Automatens namn som i resten av panelen: "BL-002 Mobilia". */
export function machineLabel(m: Pick<MachineRecord, "code" | "name">): string {
  return m.name.startsWith(m.code) ? m.name : `${m.code} ${m.name}`;
}

/**
 * Godtar en träff: etiketten får matcha som delsekvens (BL2 → BL-002) när frågan har
 * minst tre tecken; kortare frågor kräver delsträng. Hint och nyckelord kräver alltid
 * delsträng (matchFields).
 */
function accept(q: string, m: FieldMatch | null): m is FieldMatch {
  if (!m) return false;
  if (m.tier >= TIER.substring) return true;
  return normalize(q).replace(/\s+/g, "").length >= 3;
}

function rank<T>(
  items: readonly T[],
  q: string,
  fields: (item: T) => { label: string; hint?: string; keywords?: readonly string[] },
): T[] {
  const out: Array<{ item: T; score: number; order: number }> = [];
  items.forEach((item, order) => {
    const m = matchFields(q, fields(item));
    if (accept(q, m)) out.push({ item, score: m.score, order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.map((r) => r.item);
}

function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}

/** Vart en titel leder för rollen. */
function titleHit(t: TitleRecord, role: MemberRole, aliases: readonly string[]): SearchHit {
  const meta = t.series ? [t.series] : [];
  const keywords = [t.series, ...aliases].filter((k): k is string => !!k);
  if (role === "refiller") {
    // Påfyllaren har varken Lönsamhet eller Inköpspriser: titeln startar en påfyllning.
    return {
      id: `title:${t.id}`,
      kind: "title",
      entityId: t.id,
      label: t.name,
      meta,
      keywords,
      carry: "none",
      step: "refill-machine",
    };
  }
  return {
    id: `title:${t.id}`,
    kind: "title",
    entityId: t.id,
    label: t.name,
    meta,
    keywords,
    href: `/inkopspriser?titel=${encodeURIComponent(t.id)}`,
    carry: "all",
  };
}

function machineHit(m: MachineRecord, role: MemberRole, storeName: string | null): SearchHit {
  const base = {
    id: `machine:${m.id}`,
    kind: "machine" as const,
    entityId: m.id,
    label: machineLabel(m),
    meta: storeName ? [storeName] : [],
    keywords: [m.code, m.name, m.serial, storeName].filter((k): k is string => !!k),
  };
  // Påfyllaren har inte Automater: lagret filtrerat på automaten.
  return role === "refiller"
    ? { ...base, href: `/lager?automat=${encodeURIComponent(m.id)}`, carry: "period" }
    : { ...base, href: `/automater/${encodeURIComponent(m.id)}`, carry: "all" };
}

function storeHit(s: StoreRecord, role: MemberRole, machineCount: number): SearchHit {
  const base = {
    id: `store:${s.id}`,
    kind: "store" as const,
    entityId: s.id,
    label: s.name,
    meta: machineCount > 0 ? [plural(machineCount, "automat", "automater")] : [],
    keywords: [s.address].filter((k): k is string => !!k),
  };
  return role === "refiller"
    ? { ...base, href: `/lager?butik=${encodeURIComponent(s.id)}`, carry: "period" }
    : { ...base, href: `/butiker/${encodeURIComponent(s.id)}`, carry: "all" };
}

/** Träffar i titlar, automater och butiker (arkiverade och sammanslagna utelämnas). */
export function masterGroups(q: string, master: SearchMaster, role: MemberRole): SearchGroup[] {
  if (!q) return [];
  const storeById = new Map(master.stores.map((s) => [s.id, s]));
  const titles = master.titles.filter((t) => !t.archived);
  const machines = master.machines.filter((m) => !m.archived);
  const stores = master.stores.filter((s) => !s.archived);

  const titleHits = rank(titles, q, (t) => ({
    label: t.name,
    keywords: [t.series, ...(master.aliases.get(t.id) ?? [])].filter((k): k is string => !!k),
  }))
    .slice(0, HITS_PER_GROUP)
    .map((t) => titleHit(t, role, master.aliases.get(t.id) ?? []));

  const machineHits = rank(machines, q, (m) => {
    const store = m.storeId ? storeById.get(m.storeId) : undefined;
    return {
      label: machineLabel(m),
      hint: store?.name,
      keywords: [m.serial, store?.address].filter((k): k is string => !!k),
    };
  })
    .slice(0, HITS_PER_GROUP)
    .map((m) => machineHit(m, role, m.storeId ? (storeById.get(m.storeId)?.name ?? null) : null));

  const counts = new Map<string, number>();
  for (const m of machines) if (m.storeId) counts.set(m.storeId, (counts.get(m.storeId) ?? 0) + 1);
  const storeHits = rank(stores, q, (s) => ({
    label: s.name,
    keywords: [s.address].filter((k): k is string => !!k),
  }))
    .slice(0, HITS_PER_GROUP)
    .map((s) => storeHit(s, role, counts.get(s.id) ?? 0));

  const groups: SearchGroup[] = [];
  if (titleHits.length) groups.push({ kind: "title", label: "Titlar", hits: titleHits });
  if (machineHits.length) groups.push({ kind: "machine", label: "Automater", hits: machineHits });
  if (storeHits.length) groups.push({ kind: "store", label: "Butiker", hits: storeHits });
  return groups;
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/** Ett sökord och de titlar och automater vars namn innehåller det. */
export interface OrderTerm {
  readonly text: string;
  readonly pattern: string;
  readonly titleIds: readonly string[];
  readonly machineIds: readonly string[];
}

const INDEXABLE_RUN = new RegExp(`[\\p{L}\\p{N}]{${MIN_ORDER_TERM}}`, "u");

/**
 * Sant om ordet kan använda trigramindexet: minst MIN_ORDER_TERM bokstäver eller
 * siffror i följd ("asc", "001" i "bl-001"). Bara längden räcker inte: "---", "..."
 * och "%_%_%" har inga trigram och skulle läsa alla organisationens order.
 */
export function isIndexableTerm(term: string): boolean {
  return INDEXABLE_RUN.test(term);
}

/** Sökordens villkor för order, eller null om sökningen inte ska gå mot order. */
export function orderTerms(q: string, master: SearchMaster): OrderTerm[] | null {
  const terms = searchTerms(q);
  // Utan ett ord som kan använda trigramindexet: ingen ordersökning. Övriga ord
  // (t.ex. "e" i "asc e") filtrerar bara bland de rader indexet redan gett.
  if (!terms.some(isIndexableTerm)) return null;
  return terms.map((text) => {
    const n = normalize(text);
    const titleIds = master.titles
      .filter(
        (t) =>
          normalize(t.name).includes(n) ||
          (master.aliases.get(t.id) ?? []).some((a) => normalize(a).includes(n)),
      )
      .map((t) => t.id);
    const machineIds = master.machines
      .filter((m) => normalize(m.code).includes(n) || normalize(m.name).includes(n))
      .map((m) => m.id);
    return { text, pattern: containsPattern(text), titleIds, machineIds };
  });
}

/** En order som sökningen hittat (rad ur ./queries). */
export interface OrderSearchRow {
  readonly id: string;
  readonly externalId: string;
  readonly orderedAt: string;
  readonly amountOre: number;
  readonly rawTitle: string;
  readonly titleId: string | null;
  readonly machineId: string | null;
}

/** Betalt belopp: hela kronor utan decimaler, annars med öre ("170 kr", "79,50 kr"). */
export function formatPaid(amountOre: number): string {
  return formatKronor(amountOre / 100, { decimals: amountOre % 100 === 0 ? 0 : 2 });
}

/** "1 nov. 17:17" i organisationens tidszon (året bara om det inte är i år). */
export function formatOrderedAt(iso: string, timeZone: string, now: Date): string {
  return formatDateTime(wallClockIn(new Date(iso), timeZone), {
    now: wallClockIn(now, timeZone),
  });
}

/**
 * Orderträffarna: exakta ordernummer först, sedan de senaste. Gruppen får en länk
 * till orderlistan med samma sökning när det kan finnas fler. Bara för roller som
 * ser ekonomi; för andra roller blir det ingen grupp alls.
 */
export function orderGroup(args: {
  q: string;
  role: MemberRole;
  exact: readonly OrderSearchRow[];
  recent: readonly OrderSearchRow[];
  /** Sant om frågan efter de senaste gav fler rader än som visas. */
  more: boolean;
  master: SearchMaster;
  timeZone: string;
  now: Date;
}): SearchGroup | null {
  if (!canSeeEconomy(args.role)) return null;
  const seen = new Set<string>();
  const rows: OrderSearchRow[] = [];
  for (const r of [...args.exact, ...args.recent]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    rows.push(r);
  }
  if (rows.length === 0) return null;
  const titleName = new Map(args.master.titles.map((t) => [t.id, t.name]));
  const machineCode = new Map(args.master.machines.map((m) => [m.id, m.code]));
  const hits: SearchHit[] = rows.slice(0, HITS_PER_GROUP).map((r) => ({
    id: `order:${r.id}`,
    kind: "order",
    entityId: r.id,
    code: r.externalId,
    label: (r.titleId ? titleName.get(r.titleId) : undefined) ?? r.rawTitle,
    meta: [
      ...(r.machineId && machineCode.has(r.machineId) ? [machineCode.get(r.machineId)!] : []),
      formatOrderedAt(r.orderedAt, args.timeZone, args.now),
      formatPaid(r.amountOre),
    ],
    keywords: [r.rawTitle],
    // Detaljvyn öppnas oavsett period; listan bakom visar samma ordernummer i hela historiken.
    href: `/order?${new URLSearchParams({ period: "allt", q: r.externalId, order: r.id })}`,
    carry: "none",
  }));
  const more = args.more || rows.length > HITS_PER_GROUP;
  return {
    kind: "order",
    label: "Order",
    hits,
    more: more
      ? {
          label: `Alla order som matchar ”${args.q}”`,
          href: `/order?${new URLSearchParams({ period: "allt", q: args.q })}`,
        }
      : undefined,
  };
}

/**
 * Gruppernas ordning: ser frågan ut som ett ordernummer kommer order först, annars
 * titlar, automater, butiker och sist order.
 */
export function orderGroups(q: string, groups: readonly (SearchGroup | null)[]): SearchGroup[] {
  const present = groups.filter((g): g is SearchGroup => g !== null);
  const rankOf = (g: SearchGroup) =>
    looksLikeOrderNumber(q) && g.kind === "order"
      ? -1
      : ["title", "machine", "store", "order"].indexOf(g.kind);
  return [...present].sort((a, b) => rankOf(a) - rankOf(b));
}

// ---------------------------------------------------------------------------
// Steg: välj titel
// ---------------------------------------------------------------------------

/** Titlar för påfyllning i en automat: de som står i automaten först (minst kvar först). */
export function refillPick(
  titles: readonly TitleRecord[],
  stockInMachine: ReadonlyMap<string, number>,
): PickGroup[] {
  const active = titles.filter((t) => !t.archived);
  const inMachine = active
    .filter((t) => stockInMachine.has(t.id))
    .sort(
      (a, b) =>
        (stockInMachine.get(a.id) ?? 0) - (stockInMachine.get(b.id) ?? 0) ||
        a.name.localeCompare(b.name, "sv"),
    )
    .map((t) => ({
      id: t.id,
      label: t.name,
      meta: [`${formatInt(stockInMachine.get(t.id) ?? 0)} st kvar`],
      keywords: t.series ? [t.series] : [],
    }));
  const others = active
    .filter((t) => !stockInMachine.has(t.id))
    .map((t) => ({ id: t.id, label: t.name, meta: [], keywords: t.series ? [t.series] : [] }));
  const groups: PickGroup[] = [];
  if (inMachine.length) groups.push({ label: "I automaten", items: inMachine });
  if (others.length) groups.push({ label: "Övriga titlar", items: others });
  return groups;
}

/** Titlar för nytt inköpspris: de utan pris först. */
export function pricePick(
  titles: readonly TitleRecord[],
  priced: ReadonlySet<string>,
): PickGroup[] {
  const active = titles.filter((t) => !t.archived);
  const missing = active
    .filter((t) => !priced.has(t.id))
    .map((t) => ({
      id: t.id,
      label: t.name,
      meta: ["Saknar pris"],
      keywords: t.series ? [t.series] : [],
    }));
  const rest = active
    .filter((t) => priced.has(t.id))
    .map((t) => ({ id: t.id, label: t.name, meta: [], keywords: t.series ? [t.series] : [] }));
  const groups: PickGroup[] = [];
  if (missing.length) groups.push({ label: "Saknar inköpspris", items: missing });
  if (rest.length) groups.push({ label: "Med inköpspris", items: rest });
  return groups;
}
