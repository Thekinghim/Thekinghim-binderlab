/**
 * Mystery packs: räkningen bakom innehållet och packningen. Ren (inga beroenden på Next eller
 * databasen), testas i ./model.test.ts.
 *
 * - Chans (per rad och till hit): antal av omgången, i baspunkter (avrundat en gång).
 * - Snittkostnad per mystery pack: Σ (antal × dagens inköpspris) / omgångens storlek, avrundat
 *   till öre. Saknar någon del inköpspris saknas snittet (vi gissar aldrig).
 * - Kan packa: hur många hela omgångar ett lager räcker till, och vilken del som tar slut först.
 * - Packa N omgångar: vad som tas ut (antal × N per del) och vad som läggs till (storlek × N).
 * - Saknas: vilka delar ett lager inte har nog av för N omgångar, och hur många som fattas.
 * - Standardlager: lagret med flest pack av delarna (lika: standardlagret, sedan ordningen).
 * - Kalkylen: kostnad per omgång och per pack, pris, vinst och marginal per pack (före
 *   butikens andel), även för ett utkast som inte är sparat ("vad händer om").
 */

import { sellOut } from "@/analytics/sellout";
import {
  addDays,
  dayOfWeek,
  daysBetween,
  recipeCost,
  unitMargin,
  type IsoDate,
  type MysteryDueSlot,
  type MysteryPackPlan,
  type MysterySlotInput,
} from "@/domain";
import type { Messages } from "@/i18n/sv";

/** En rad i innehållet: en titel, antal per omgång och om den är en HIT. */
export interface RecipeItem {
  readonly titleId: string;
  readonly name: string;
  readonly quantity: number;
  readonly hit: boolean;
}

/** En version av innehållet. */
export interface Recipe {
  readonly id: string;
  readonly titleId: string;
  readonly version: number;
  readonly validFrom: string;
  readonly batchSize: number;
  readonly note: string | null;
  readonly items: readonly RecipeItem[];
}

/** Ett eget lager (Hemma, Kontoret …). */
export interface Place {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
}

export const DEFAULT_BATCH_SIZE = 14;
export const MAX_BATCHES = 10;
export const MAX_ITEMS = 30;
export const MAX_BATCH_SIZE = 200;
/** Ångra går inom så här många minuter (samma som databasen). */
export const UNDO_MINUTES = 30;

/** Andel i baspunkter, avrundad halvt uppåt (0 om nämnaren är 0). */
export function shareBp(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  return Math.round((part * 10_000) / whole);
}

export interface Odds {
  /** Antal HIT-pack per omgång. */
  readonly hits: number;
  /** Chans till hit i ett mystery pack (bp). */
  readonly hitBp: number;
  /** Chansen per rad (bp), i innehållets ordning. */
  readonly items: ReadonlyArray<RecipeItem & { readonly bp: number }>;
}

/** Chansen per rad och till en hit. */
export function recipeOdds(recipe: Pick<Recipe, "batchSize" | "items">): Odds {
  const hits = recipe.items.reduce((n, i) => n + (i.hit ? i.quantity : 0), 0);
  return {
    hits,
    hitBp: shareBp(hits, recipe.batchSize),
    items: recipe.items.map((i) => ({ ...i, bp: shareBp(i.quantity, recipe.batchSize) })),
  };
}

export interface AverageCost {
  /** Snittkostnad per mystery pack (öre), null när någon del saknar inköpspris. */
  readonly perPackOre: number | null;
  /** Kostnaden för en hel omgång (öre), null när någon del saknar inköpspris. */
  readonly perBatchOre: number | null;
  /** Delarna som saknar inköpspris (namn, i innehållets ordning). */
  readonly missing: readonly string[];
}

/** Snittkostnaden per mystery pack med dagens inköpspriser (titelns id → öre). */
export function averageCost(
  recipe: Pick<Recipe, "batchSize" | "items">,
  prices: ReadonlyMap<string, number>,
): AverageCost {
  const cost = recipeCost(recipe, (id) => prices.get(id));
  const missing = new Set(cost.missingTitleIds);
  return {
    perPackOre: cost.perPackOre,
    perBatchOre: cost.perBatchOre,
    missing: recipe.items.filter((i) => missing.has(i.titleId)).map((i) => i.name),
  };
}

/** En rad i kalkylen: en del, antal per omgång, pris per pack och radens summa. */
export interface CalcLine {
  readonly titleId: string;
  readonly name: string;
  readonly quantity: number;
  readonly hit: boolean;
  /** Delens inköpspris i dag (öre), null när det saknas. */
  readonly unitCostOre: number | null;
  /** antal × pris (öre), null när priset saknas. */
  readonly totalOre: number | null;
}

/** Kalkylen för ett mystery pack: kostnad, pris, vinst och marginal per pack. */
export interface MysteryCalc {
  readonly batchSize: number;
  readonly lines: readonly CalcLine[];
  /** Summan av antalen. Kalkylen går bara ihop när den är omgångens storlek. */
  readonly quantity: number;
  /** Antalen är omgångens storlek och alla delar har pris. */
  readonly complete: boolean;
  readonly perBatchOre: number | null;
  readonly perPackOre: number | null;
  /** Delarna som saknar inköpspris (namn). */
  readonly missing: readonly string[];
  /** Priset i automaten (öre, med moms), null utan köp. */
  readonly salePriceOre: number | null;
  /** Vinst per pack före butikens andel (öre), null utan pris eller kostnad. */
  readonly profitOre: number | null;
  /** Vinsten i bp av priset utan moms. */
  readonly marginBp: number | null;
}

/** Avgifterna som dras från priset (organisationens inställningar). */
export interface CalcFees {
  readonly vatRateBp: number;
  readonly cardFeeBp: number;
}

/**
 * Kalkylen med ett innehåll (sparat eller ett utkast), dagens inköpspriser på delarna
 * (titelns id → öre) och priset i automaten. Samma formler som liggaren (@/domain
 * unitMargin): vinst = pris utan moms − kortavgift − kostnad, före butikens andel.
 */
export function mysteryCalc(
  batchSize: number,
  items: ReadonlyArray<{ titleId: string; name: string; quantity: number; hit?: boolean }>,
  prices: Readonly<Record<string, number>>,
  salePriceOre: number | null,
  fees: CalcFees,
): MysteryCalc {
  const clean = items.map((i) => ({
    ...i,
    quantity: Number.isInteger(i.quantity) && i.quantity > 0 ? i.quantity : 0,
  }));
  const cost = recipeCost({ batchSize, items: clean }, (id) => prices[id]);
  const lines = clean.map((i, n): CalcLine => ({
    titleId: i.titleId,
    name: i.name,
    quantity: i.quantity,
    hit: i.hit === true,
    unitCostOre: cost.lines[n]?.unitCostOre ?? null,
    totalOre: cost.lines[n]?.totalOre ?? null,
  }));
  const complete = cost.perPackOre !== null && cost.quantity === batchSize;
  const perPackOre = complete ? cost.perPackOre : null;
  const margin =
    perPackOre !== null && salePriceOre !== null && salePriceOre > 0
      ? unitMargin(salePriceOre, perPackOre, fees)
      : null;
  return {
    batchSize,
    lines,
    quantity: cost.quantity,
    complete,
    perBatchOre: complete ? cost.perBatchOre : null,
    perPackOre,
    missing: lines.filter((l) => l.unitCostOre === null).map((l) => l.name),
    salePriceOre,
    profitOre: margin?.profitOre ?? null,
    marginBp: margin?.marginBp ?? null,
  };
}

export interface Capacity {
  /** Hela omgångar lagret räcker till. */
  readonly batches: number;
  /** Delen som tar slut först (null utan rader). Lika: den som står först i innehållet. */
  readonly limiting: RecipeItem | null;
}

/** Hur många omgångar ett lager räcker till (titelns id → pack i lagret). */
export function maxBatches(
  recipe: Pick<Recipe, "items">,
  stock: Readonly<Record<string, number>>,
): Capacity {
  let best: Capacity | null = null;
  for (const i of recipe.items) {
    const have = Math.max(0, stock[i.titleId] ?? 0);
    const n = Math.floor(have / i.quantity);
    if (best === null || n < best.batches) best = { batches: n, limiting: i };
  }
  return best ?? { batches: 0, limiting: null };
}

export interface Take {
  readonly titleId: string;
  readonly name: string;
  readonly quantity: number;
}

export interface PackPlan {
  readonly batches: number;
  /** Pack som tas ur lagret, per del. */
  readonly takes: readonly Take[];
  /** Mystery packs som läggs till. */
  readonly packs: number;
}

/** Vad N omgångar tar ut och lägger till. */
export function packPlan(recipe: Pick<Recipe, "batchSize" | "items">, batches: number): PackPlan {
  return {
    batches,
    takes: recipe.items.map((i) => ({
      titleId: i.titleId,
      name: i.name,
      quantity: i.quantity * batches,
    })),
    packs: recipe.batchSize * batches,
  };
}

/** Delarna som lagret inte har nog av för N omgångar, och hur många som fattas. */
export function shortages(
  recipe: Pick<Recipe, "items">,
  batches: number,
  stock: Readonly<Record<string, number>>,
): Take[] {
  const out: Take[] = [];
  for (const i of recipe.items) {
    const need = i.quantity * batches;
    const have = Math.max(0, stock[i.titleId] ?? 0);
    if (have < need) out.push({ titleId: i.titleId, name: i.name, quantity: need - have });
  }
  return out;
}

/** Omgångar för ett antal mystery packs (avrundat uppåt, 1–MAX_BATCHES). */
export function batchesForPacks(packs: number, batchSize: number): number {
  if (!(batchSize > 0) || !(packs > 0)) return 1;
  return Math.min(MAX_BATCHES, Math.max(1, Math.ceil(packs / batchSize)));
}

/** Lagret att packa i: flest pack av delarna. Lika: standardlagret, sedan listans ordning. */
export function defaultPlace(
  recipe: Pick<Recipe, "items">,
  places: readonly Place[],
  byPlace: Readonly<Record<string, Readonly<Record<string, number>>>>,
): Place | null {
  let best: { place: Place; score: number } | null = null;
  for (const p of places) {
    const stock = byPlace[p.id] ?? {};
    const score = recipe.items.reduce((n, i) => n + Math.max(0, stock[i.titleId] ?? 0), 0);
    if (
      best === null ||
      score > best.score ||
      (score === best.score && p.isDefault && !best.place.isDefault)
    ) {
      best = { place: p, score };
    }
  }
  return best?.place ?? null;
}

/** "8 Phantasmal Flames, 6 Delta Reign och 4 Destined Rivals". */
export function listText(takes: readonly Take[]): string {
  const parts = takes.map((t) => `${t.quantity} ${t.name}`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} och ${parts.at(-1)}`;
}

/** Adressen till Packa för en titel, med ett antal mystery packs förvalt (Inköps "Packa X st"). */
export function packHref(titleId: string, packs?: number | null): string {
  const q = packs && packs > 0 ? `?packa=${Math.trunc(packs)}` : "";
  return `/vart-lager/mystery/${titleId}${q}#packa`;
}

/** "1 omgång" · "2 omgångar". */
export function batchesText(n: number): string {
  return `${n} ${n === 1 ? "omgång" : "omgångar"}`;
}

// ---------------------------------------------------------------------------
// Redigeraren
// ---------------------------------------------------------------------------

export interface DraftItem {
  readonly titleId: string;
  readonly quantity: number;
  readonly hit: boolean;
}

export interface DraftCheck {
  readonly ok: boolean;
  /** Summan av antalen. */
  readonly sum: number;
  /** Första felet att visa (kort), eller null. */
  readonly error: string | null;
}

/** Samma regler som databasen (save_mystery_recipe), för att visa felet innan man sparar. */
export function checkDraft(batchSize: number, items: readonly DraftItem[]): DraftCheck {
  const sum = items.reduce((n, i) => n + (Number.isInteger(i.quantity) ? i.quantity : 0), 0);
  const fail = (error: string): DraftCheck => ({ ok: false, sum, error });
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    return fail(`En omgång är 1–${MAX_BATCH_SIZE} pack.`);
  }
  if (items.length === 0) return fail("Lägg till minst en titel.");
  if (items.length > MAX_ITEMS) return fail(`Högst ${MAX_ITEMS} titlar.`);
  if (items.some((i) => !i.titleId)) return fail("Välj en titel på varje rad.");
  if (new Set(items.map((i) => i.titleId)).size !== items.length) {
    return fail("Samma titel står två gånger.");
  }
  if (items.some((i) => !Number.isInteger(i.quantity) || i.quantity < 1)) {
    return fail("Varje rad behöver minst 1.");
  }
  if (sum !== batchSize) {
    const diff = batchSize - sum;
    return fail(diff > 0 ? `${diff} kvar att lägga till.` : `${-diff} för många.`);
  }
  return { ok: true, sum, error: null };
}

// ---------------------------------------------------------------------------
// Minus i lagret (påfyllt utan att trycka Packa)
// ---------------------------------------------------------------------------

/** Vad som rättar ett minus: packa hela omgångar, eller räkna om lagret. */
export type MinusFix =
  | { readonly kind: "pack"; readonly batches: number; readonly packs: number }
  | { readonly kind: "count" };

/**
 * Ett lager står på minus för ett mystery pack: någon har fyllt på utan att trycka Packa.
 * - Minuset är hela omgångar (−14, −28 med 14 per omgång): "Packa 1 omgång nu" rättar det,
 *   och delarna dras ur lagret.
 * - Annars (−1, −15) eller fler än MAX_BATCHES omgångar: lagret behöver räknas om.
 * - 0 eller mer, eller okänd omgång: null (inget att rätta).
 */
export function minusFix(quantity: number, batchSize: number | null | undefined): MinusFix | null {
  if (!Number.isFinite(quantity) || quantity >= 0) return null;
  const minus = -Math.trunc(quantity);
  if (!batchSize || !Number.isInteger(batchSize) || batchSize < 1) return { kind: "count" };
  const batches = minus / batchSize;
  if (!Number.isInteger(batches) || batches > MAX_BATCHES) return { kind: "count" };
  return { kind: "pack", batches, packs: minus };
}

/** Packa i ett bestämt lager med antalet förvalt (rättar ett minus där). */
export function packInPlaceHref(titleId: string, placeId: string, packs: number): string {
  return `/vart-lager/mystery/${titleId}?packa=${Math.trunc(packs)}&lager=${placeId}#packa`;
}

/** Inventeringen av ett eget lager. */
export function countHref(placeId: string): string {
  return `/vart-lager/inventering?lager=${placeId}`;
}

// ---------------------------------------------------------------------------
// "Packa 1 omgång före fredag": räknat från facken i automaterna
// ---------------------------------------------------------------------------

/** Fönstret för takten i ett mystery-fack (hela dagar t.o.m. i går), som Fyll på. */
export const SLOT_WINDOW_DAYS = 14;

/** Ett mystery-fack i en automat, som laddaren läser det. */
export interface SlotFacts {
  readonly machineId: string;
  /** Automatens kod ("BL-001"). */
  readonly label: string;
  /** Pack i facket nu, null = inget känt saldo (aldrig läst eller påfyllt). */
  readonly onHand: number | null;
  /** Sålda pack de senaste SLOT_WINDOW_DAYS hela dagarna. */
  readonly sold: number;
  /** Automaten har sålt något alls någon gång (annars är den ny). */
  readonly everSold: boolean;
  /**
   * Dagen automaten togs i drift, om känd. En automat som startat inom fönstret får takten
   * räknad på dagarna sedan start (som Att göra och besöksplanen), inte på 14.
   */
  readonly activeFrom?: IsoDate | null;
}

/**
 * Facken som mysteryBatchesToPack() vill ha dem. Dagen facket står tomt är dagen EFTER appens
 * gemensamma slutdag:
 *
 *   slutdag  = sellOut(i facket, takt, från i går, automatens veckoform)   ← samma anrop som
 *              Att göra, besöksplanen, Lager och Automater ("Tar slut på torsdag")
 *   tomt     = slutdag + 1                                                 ← "tom på fredag"
 *
 * Det är samma dag som besöksplanen sätter för ett mystery pack (besök dagen efter beräknat
 * slut, eftersom facket bara fylls när det är tomt). Takten räknas som på de sidorna: sålda
 * pack de senaste 14 hela dagarna t.o.m. i går, eller sedan automaten togs i drift om det är
 * kortare. `weekShareOf` ger automatens veckoform (weekShapesInRequest: helgen säljer mer);
 * utan den räknas ett platt snitt, och då är svaret detsamma som före R2-9.
 */
export function slotInputs(
  facts: readonly SlotFacts[],
  today: IsoDate,
  weekShareOf?: (machineId: string) => readonly number[] | null | undefined,
): MysterySlotInput[] {
  const asOf = addDays(today, -1);
  const windowStart = addDays(asOf, -(SLOT_WINDOW_DAYS - 1));
  return facts.map((f) => {
    const onHand = Math.max(0, Math.trunc(f.onHand ?? 0));
    const days =
      f.activeFrom && f.activeFrom > windowStart
        ? Math.max(0, daysBetween(f.activeFrom, asOf) + 1)
        : SLOT_WINDOW_DAYS;
    const out =
      onHand > 0 && days > 0
        ? sellOut({
            onHand,
            dailyAvg: { units: Math.max(0, f.sold), days },
            from: asOf,
            weekShare: weekShareOf?.(f.machineId) ?? null,
          })
        : null;
    return {
      label: f.label,
      onHand,
      emptyOn: out ? addDays(out.date, 1) : null,
      isNew: !f.everSold,
    };
  });
}

/**
 * Pack i ett lager som går jämnt upp i hela omgångar (avrundat nedåt): 20 pack med 14 per
 * omgång → 14. Under 0 → 0. Färdiga omgångar räknas per lager, eftersom ett fack fylls med
 * en hel omgång från ett lager.
 */
export function wholeBatchesDown(packs: number, batchSize: number): number {
  if (!Number.isFinite(packs) || !Number.isInteger(batchSize) || batchSize < 1) return 0;
  return Math.floor(Math.max(0, packs) / batchSize) * batchSize;
}

/** Meningen om vad som ska packas, och om den är en uppmaning ("act") eller lugn ("calm"). */
export interface PackSentence {
  readonly text: string;
  readonly tone: "act" | "calm";
}

type PackTexts = Messages["r2"]["t1"]["mystery"];

function slotText(d: MysteryDueSlot, m: PackTexts): string {
  if (d.emptyNow) return m.slotEmpty(d.label);
  return d.daysLeft <= 1 ? m.slotTomorrow(d.label) : m.slotInDays(d.label, d.daysLeft);
}

/**
 * En mening för kortet och sidan:
 * - "Packa 1 omgång före fredag. BL-001 är tom om ca 3 dagar."
 * - "Packa 1 omgång nu. BL-001 är tom." · "Ny automat BL-004: packa 1 omgång."
 * - "1 omgång ligger klar hemma. BL-001 är tom om ca 3 dagar."
 * - "Inget att packa den här veckan."
 * null utan innehåll (inget mystery pack) eller när facken inte är kända.
 */
export function packSentence(plan: MysteryPackPlan | null, t: Messages): PackSentence | null {
  if (!plan || plan.basis !== "slots") return null;
  const m = t.r2.t1.mystery;
  const first = plan.first ?? null;
  if (plan.batches > 0 && first) {
    const lead = first.emptyNow
      ? first.isNew
        ? plan.batches === 1
          ? m.packNew(1, first.label)
          : // Flera omgångar: antalet gäller alla facken, inte bara den nya automaten.
            `${m.packNow(plan.batches)}. ${m.slotNew(first.label)}`
        : `${m.packNow(plan.batches)}. ${m.slotEmpty(first.label)}`
      : first.daysLeft <= 1
        ? `${m.packToday(plan.batches)} ${m.slotTomorrow(first.label)}`
        : `${m.packBefore(plan.batches, m.weekdays[dayOfWeek(first.emptyOn) - 1] ?? "")} ${m.slotInDays(first.label, first.daysLeft)}`;
    const more = plan.batches - 1;
    return { text: more > 0 ? `${lead} ${m.moreSlots(more)}` : lead, tone: "act" };
  }
  if (plan.readyBatches > 0) {
    const next = plan.due?.[0];
    const ready = m.readyHome(plan.readyBatches);
    return { text: next ? `${ready} ${slotText(next, m)}` : ready, tone: "calm" };
  }
  return { text: m.nothingToPack, tone: "calm" };
}
