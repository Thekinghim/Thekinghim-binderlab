/**
 * Gemensamt för assistentens verktyg: sammanhanget (vem som frågar, i dag, stamdata),
 * validering av perioder och filter, uppslag av automater/butiker/titlar på namn eller
 * kod, och formatering av belopp och andelar för både modellen och underlaget.
 *
 * Verktygen räknar inget själva: talen kommer från @/domain, @/analytics och
 * serverladdarna (src/server/data/core), som läser som användaren med RLS.
 */

import "server-only";

import { z } from "zod";

import type { MemberRole } from "@/db/schema";
import { addDays, daysBetween, isIsoDate, type IsoDate, type Period } from "@/domain";
import { formatInt, formatKronor, formatPercent, formatPeriod, formatSek } from "@/lib/format";
import { normalize } from "@/lib/fuzzy";
import type { Viewer } from "@/server/data/core/loaders";
import type { MachineRecord, MasterData, StoreRecord, TitleRecord } from "@/server/data/core/types";

import type { ToolFigure, ToolLink } from "../protocol";

/** Vem som frågar och när. Skapas en gång per fråga. */
export interface ToolContext {
  readonly viewer: Viewer;
  readonly role: MemberRole;
  readonly now: Date;
  /** Dagens affärsdatum i organisationens tidszon. */
  readonly today: IsoDate;
  readonly timeZone: string;
  /** Stamdata (titlar, automater, butiker, placeringar), läst en gång per fråga. */
  master(): Promise<MasterData>;
}

/** Ett verktygs resultat: data till modellen och underlaget till användaren. */
export interface ToolOutput {
  /** En mening med de viktigaste talen. Visas i underlaget och skickas till modellen. */
  readonly summary: string;
  /** Data till modellen (JSON). Belopp finns både formaterade ("12 480 kr") och i öre. */
  readonly data: unknown;
  readonly figures: readonly ToolFigure[];
  readonly links: readonly ToolLink[];
}

/** Ett fel som modellen ska få tillbaka som verktygsfel (fel parameter, okänt namn …). */
export class ToolInputError extends Error {
  constructor(
    message: string,
    /** Förslag som hjälper modellen att rätta sig, t.ex. giltiga automater. */
    readonly hint?: unknown,
  ) {
    super(message);
    this.name = "ToolInputError";
  }
}

export interface AssistantTool<I = Record<string, unknown>> {
  /** Namnet modellen anropar (a–z, _). */
  readonly name: string;
  /** Svenskt namn i listan över verktyg, t.ex. "Lönsamhet". */
  readonly title: string;
  /** Svensk etikett för ett anrop i underlaget, t.ex. "Lönsamhet per automat". */
  readonly label: (input: I) => string;
  /** Beskrivningen modellen läser: när verktyget ska användas och vad det returnerar. */
  readonly description: string;
  /** Rollerna som får verktyget. Påfyllare får bara lagerverktyg. */
  readonly roles: readonly MemberRole[];
  readonly input: z.ZodType<I>;
  run(ctx: ToolContext, input: I): Promise<ToolOutput>;
}

/** Hjälp för typning: verktyget med sin egen indatatyp. */
export function defineTool<I>(tool: AssistantTool<I>): AssistantTool<I> {
  return tool;
}

// ---------------------------------------------------------------------------
// Scheman för parametrar
// ---------------------------------------------------------------------------

const isoDate = (description: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum skrivs ÅÅÅÅ-MM-DD.")
    .refine(isIsoDate, "Ogiltigt datum.")
    .describe(description);

export const periodSchema = {
  fran: isoDate("Periodens första dag, ÅÅÅÅ-MM-DD (ingår)."),
  till: isoDate("Periodens sista dag, ÅÅÅÅ-MM-DD (ingår). Senast i dag."),
};

export const scopeSchema = {
  automat: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Begränsa till en automat: kod (BL-002), namn eller id. Utelämna för alla."),
  butik: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Begränsa till en butik: namn eller id. Utelämna för alla."),
};

/** Längsta period ett verktyg räknar på (drygt två år). */
export const MAX_PERIOD_DAYS = 800;

/** Perioden ur parametrarna. Slutet kapas vid i dag; tomma och för långa perioder nekas. */
export function periodFrom(ctx: ToolContext, input: { fran: string; till: string }): Period {
  if (input.fran > input.till) {
    throw new ToolInputError(
      `Perioden börjar (${input.fran}) efter att den slutar (${input.till}).`,
    );
  }
  if (input.fran > ctx.today) {
    throw new ToolInputError(
      `Perioden börjar efter i dag (${ctx.today}). Det finns ingen data än.`,
    );
  }
  const end = input.till > ctx.today ? ctx.today : input.till;
  if (daysBetween(input.fran, end) + 1 > MAX_PERIOD_DAYS) {
    throw new ToolInputError(`Perioden är för lång (högst ${MAX_PERIOD_DAYS} dagar).`);
  }
  return { start: input.fran, end };
}

/** Lika lång period direkt före. */
export function periodBefore(period: Period): Period {
  const days = daysBetween(period.start, period.end) + 1;
  return { start: addDays(period.start, -days), end: addDays(period.start, -1) };
}

// ---------------------------------------------------------------------------
// Uppslag på namn, kod eller id
// ---------------------------------------------------------------------------

interface Named {
  readonly id: string;
  readonly name: string;
  readonly code?: string;
  readonly archived?: boolean;
}

function codeKey(value: string): string {
  return normalize(value).replace(/[^a-z0-9]/g, "");
}

/** Hittar exakt en post. Kastar ToolInputError med kandidater annars. */
export function resolveOne<T extends Named>(items: readonly T[], query: string, what: string): T {
  const q = query.trim();
  const byId = items.find((i) => i.id.toLowerCase() === q.toLowerCase());
  if (byId) return byId;
  const qn = normalize(q);
  const qc = codeKey(q);
  const exact = items.filter(
    (i) =>
      normalize(i.name) === qn || (i.code !== undefined && qc !== "" && codeKey(i.code) === qc),
  );
  if (exact.length === 1) return exact[0]!;
  const partial = exact.length > 1 ? exact : items.filter((i) => normalize(i.name).includes(qn));
  const active = partial.filter((i) => !i.archived);
  const pool = active.length > 0 ? active : partial;
  if (pool.length === 1) return pool[0]!;
  const list = (pool.length > 1 ? pool : items.filter((i) => !i.archived))
    .slice(0, 20)
    .map((i) => ({
      id: i.id,
      namn: i.name,
      ...(i.code ? { kod: i.code } : {}),
    }));
  throw new ToolInputError(
    pool.length > 1
      ? `"${q}" matchar flera: välj en ${what} med kod eller id.`
      : `Hittar ingen ${what} som heter "${q}".`,
    { kandidater: list },
  );
}

export interface ResolvedScope {
  readonly machine: MachineRecord | null;
  readonly store: StoreRecord | null;
}

/** Automat och butik ur parametrarna (null = alla). */
export async function resolveScope(
  ctx: ToolContext,
  input: { automat?: string; butik?: string },
): Promise<ResolvedScope> {
  const master = await ctx.master();
  return {
    machine: input.automat ? resolveOne(master.machines, input.automat, "automat") : null,
    store: input.butik ? resolveOne(master.stores, input.butik, "butik") : null,
  };
}

export function scopeText(scope: ResolvedScope): string {
  const parts = [
    scope.machine ? `${scope.machine.name} (${scope.machine.code})` : null,
    scope.store ? scope.store.name : null,
  ].filter(Boolean);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

export function resolveTitle(master: MasterData, query: string): TitleRecord {
  return resolveOne(master.titles, query, "titel");
}

// ---------------------------------------------------------------------------
// Namn
// ---------------------------------------------------------------------------

export function nameMaps(master: MasterData) {
  return {
    title: new Map(master.titles.map((t) => [t.id, t.name])),
    machine: new Map(master.machines.map((m) => [m.id, m])),
    store: new Map(master.stores.map((s) => [s.id, s.name])),
  };
}

// ---------------------------------------------------------------------------
// Formatering (src/lib/format)
// ---------------------------------------------------------------------------

/** Öre → "12 480 kr" (hela kronor). */
export function kr(ore: number): string {
  return formatSek(ore / 100);
}

/** Öre → "12 480,50 kr". */
export function krExact(ore: number): string {
  return formatKronor(ore / 100);
}

/** Baspunkter → "23,7 %". null → "–". */
export function pct(bp: number | null): string {
  return bp === null ? "–" : formatPercent(bp / 10_000);
}

export function count(n: number): string {
  return formatInt(n);
}

function localDate(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** "oktober 2026", "1–30 nov. 2026". */
export function periodText(period: Period): string {
  return formatPeriod({ start: localDate(period.start), end: localDate(period.end) });
}

// ---------------------------------------------------------------------------
// Länkar till sidorna (period och filter i URL:en, som skalet läser dem)
// ---------------------------------------------------------------------------

export function pageHref(
  path: string,
  period: Period | null,
  scope?: { machineId?: string | null; storeId?: string | null },
): string {
  const params = new URLSearchParams();
  if (period) {
    params.set("from", period.start);
    params.set("to", period.end);
  }
  if (scope?.storeId) params.set("butik", scope.storeId);
  if (scope?.machineId) params.set("automat", scope.machineId);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
