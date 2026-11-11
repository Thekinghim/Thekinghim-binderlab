/**
 * Påfyllning av mystery packs (egna produkter med ett innehåll i Vårt lager → Mystery packs).
 *
 * Ägarens regel: oddsen på etiketten gäller per omgång (t.ex. 14 pack med 1 träff). Ett
 * mystery-fack fylls därför aldrig på medan det har pack kvar: det fylls först när det är
 * TOMT (0 pack), och då med exakt EN hel omgång (innehållets antal per omgång). Får en hel
 * omgång inte plats i facket (kapaciteten är mindre) visas en varning; förslaget är ändå en
 * hel omgång.
 *
 * Reglerna används av Fyll på, Att göra/Hem, besöksplanen och larmen på Drift, pushen till
 * Awish, Inköp/Vårt lager (packa i hela omgångar), dagliga kontrollen och förlorad
 * försäljning. Rena funktioner.
 *
 * Hur många omgångar som ska packas svarar mysteryBatchesToPack() på, för alla sidor
 * (Mystery, Vårt lager, Inköp och delägarens inköpslista), så att de säger samma sak.
 */

import { daysBetween } from "./dates";
import type { IsoDate } from "./types";

/** Varningen när någon fyller på ett mystery-fack som inte är tomt. */
export const MYSTERY_TOP_UP_WARNING = "Mystery-facket fylls bara på när det är tomt";

/**
 * Omgångens storlek för en titel som är ett mystery pack, annars null. `batchSize` kommer
 * från gällande innehåll (mystery_recipes.batch_size) och sätts bara för egna produkter.
 */
export function mysteryBatch(batchSize: number | null | undefined): number | null {
  if (batchSize === null || batchSize === undefined) return null;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) return null;
  return batchSize;
}

/** Ett mystery-fack ska fyllas på först när det är tomt (0 pack eller mindre). */
export function mysteryNeedsRefill(onHand: number): boolean {
  return onHand <= 0;
}

/**
 * Pack att fylla i ett mystery-fack: en hel omgång när facket är tomt, annars 0.
 * mysteryRefillQty(0, 14) → 14 · mysteryRefillQty(3, 14) → 0
 */
export function mysteryRefillQty(onHand: number, batchSize: number): number {
  return mysteryNeedsRefill(onHand) ? batchSize : 0;
}

/** En hel omgång får inte plats i facket (känd kapacitet mindre än omgången). */
export function mysteryCapacityShort(
  capacity: number | null | undefined,
  batchSize: number,
): boolean {
  return (
    capacity !== null &&
    capacity !== undefined &&
    Number.isSafeInteger(capacity) &&
    capacity > 0 &&
    capacity < batchSize
  );
}

/** Varningen när en hel omgång inte får plats: "Facket rymmer 10, en omgång är 14 st". */
export function mysteryCapacityText(capacity: number, batchSize: number): string {
  return `Facket rymmer ${capacity}, en omgång är ${batchSize}\u00a0st`;
}

/**
 * Antal avrundat uppåt till hela omgångar (packning och inköp av mystery packs).
 * wholeBatches(5, 14) → 14 · wholeBatches(15, 14) → 28 · wholeBatches(0, 14) → 0
 */
export function wholeBatches(quantity: number, batchSize: number): number {
  const q = Math.max(0, Math.trunc(quantity));
  if (q === 0 || batchSize < 1) return q;
  return Math.ceil(q / batchSize) * batchSize;
}

/**
 * "Mystery Pack Plus är slut – fyll på en hel omgång (14 st)", med automaten:
 * "Mystery Pack Plus är slut i BL-001 – fyll på en hel omgång (14 st)".
 */
export function mysteryEmptyText(
  titleName: string,
  batchSize: number,
  machineName?: string,
): string {
  const where = machineName ? ` i ${machineName}` : "";
  return `${titleName} är slut${where} – fyll på en hel omgång (${batchSize}\u00a0st)`;
}

/**
 * Påfyllningen i ett mystery-fack följer regeln: facket var tomt och fylls med exakt en
 * omgång. Annars en kort förklaring (för varningar, aldrig för att stoppa en påfyllning).
 */
export function mysteryRefillProblem(
  before: number,
  quantity: number,
  batchSize: number,
): "not_empty" | "not_one_batch" | null {
  if (quantity <= 0) return null;
  if (!mysteryNeedsRefill(before)) return "not_empty";
  if (quantity !== batchSize) return "not_one_batch";
  return null;
}

// ---------------------------------------------------------------------------
// Omgångar att packa
// ---------------------------------------------------------------------------

/** Så här många dagar framåt räknas ett fack som "blir tomt i veckan". */
export const MYSTERY_PACK_HORIZON_DAYS = 7;

/** Ett mystery-fack i en automat, för mysteryBatchesToPack(). */
export interface MysterySlotInput {
  /** Automaten som den visas ("BL-001"). */
  readonly label: string;
  /** Pack i facket nu. Under 0 räknas som 0. */
  readonly onHand: number;
  /**
   * Dagen facket väntas vara tomt (sellOut().date i @/analytics/sellout). null = ingen takt
   * är känd (titeln säljer inte i automaten).
   */
  readonly emptyOn: IsoDate | null;
  /** Automaten har aldrig sålt något alls (ny automat utan historik). */
  readonly isNew?: boolean;
}

/** Ett fack som behöver en omgång inom horisonten. */
export interface MysteryDueSlot {
  readonly label: string;
  /** Dagen facket är tomt: i dag när det redan är tomt. */
  readonly emptyOn: IsoDate;
  /** Hela dagar tills facket är tomt. 0 = tomt nu. */
  readonly daysLeft: number;
  readonly emptyNow: boolean;
  readonly isNew: boolean;
}

/** Underlaget till mysteryBatchesToPack(). Nya fält läggs till som valfria. */
export interface MysteryPackInput {
  /** Pack per omgång (mystery_recipes.batch_size). Ogiltig eller null: inget mystery pack. */
  readonly batchSize: number | null | undefined;
  /**
   * Pack som Inköps plan säger ska packas (purchaseQty i @/analytics/purchasing). Planen har
   * redan dragit av det som ligger hemma och i automaterna. Under 0 räknas som 0. Används
   * bara när `slots` saknas.
   */
  readonly planPacks: number;
  /** Färdiga mystery packs hemma, alla lager. Under 0 (ska räknas om) räknas som 0. */
  readonly packedAtHome?: number | null;
  /**
   * Mystery-facken i automaterna (ett per automat som har titeln). Med facken räknas
   * omgångarna från dem i stället för från planen: en omgång per fack som är tomt eller blir
   * tomt inom `horizonDays`, minus hela omgångar som redan ligger färdiga hemma. En tom lista
   * betyder "inga fack" (0 omgångar); null eller utelämnat betyder "okänt" (planens antal).
   */
  readonly slots?: readonly MysterySlotInput[] | null;
  /** Dagens datum (krävs med `slots`). */
  readonly today?: IsoDate | null;
  /** Hur långt fram ett fack räknas (standard 7 dagar). */
  readonly horizonDays?: number;
}

/** Svaret: så här många omgångar ska packas. */
export interface MysteryPackPlan {
  /** Hela omgångar att packa. 0 = inget att packa. */
  readonly batches: number;
  /** Samma sak i pack: batches × batchSize. */
  readonly packs: number;
  /** Pack per omgång. */
  readonly batchSize: number;
  /** Hela omgångar som redan ligger färdiga hemma. */
  readonly readyBatches: number;
  /**
   * Dagen omgångarna ska vara packade före ("Packa 1 omgång före fredag"): dagen det första
   * facket som inte täcks av de färdiga omgångarna är tomt. null när ingen dag är känd
   * (räknat från planen, eller inget att packa).
   */
  readonly before: IsoDate | null;
  /** "slots" när omgångarna är räknade från facken; saknas när de kommer från Inköps plan. */
  readonly basis?: "slots";
  /** Facken som behöver en omgång inom horisonten, det som blir tomt först överst. */
  readonly due?: readonly MysteryDueSlot[];
  /** Facket som bestämmer `before` (det första som de färdiga omgångarna inte räcker till). */
  readonly first?: MysteryDueSlot | null;
}

/**
 * Omgångar mystery packs att packa.
 *
 * Med facken (`slots` och `today`): ett mystery-fack fylls bara när det är tomt, med en hel
 * omgång. Varje fack som är tomt nu eller blir tomt inom 7 dagar behöver alltså en omgång.
 * Hela omgångar som redan ligger färdiga hemma dras av.
 *
 *   1 automat, 9 pack i facket, 3 om dagen (tom om 3 dagar)       → 1 omgång, före den dagen
 *   samma, men 14 färdiga hemma                                    → 0 omgångar (1 ligger klar)
 *   facket räcker 12 dagar                                         → 0 omgångar
 *
 * Utan facken: planens antal avrundat uppåt till hela omgångar (som före runda 2).
 *
 * mysteryBatchesToPack({ batchSize: 14, planPacks: 56 }) → 4 omgångar (56 pack)
 * mysteryBatchesToPack({ batchSize: 14, planPacks: 5 })  → 1 omgång (14 pack)
 * mysteryBatchesToPack({ batchSize: 14, planPacks: 0 })  → 0 omgångar
 * mysteryBatchesToPack({ batchSize: null, planPacks: 9 }) → null (inget mystery pack)
 */
export function mysteryBatchesToPack(input: MysteryPackInput): MysteryPackPlan | null {
  const batchSize = mysteryBatch(input.batchSize);
  if (batchSize === null) return null;
  const readyBatches = Math.floor(wholePacks(input.packedAtHome) / batchSize);
  if (!input.slots || !input.today) {
    const packs = wholeBatches(wholePacks(input.planPacks), batchSize);
    return { batches: packs / batchSize, packs, batchSize, readyBatches, before: null };
  }
  const today = input.today;
  const horizon =
    input.horizonDays !== undefined && Number.isFinite(input.horizonDays) && input.horizonDays >= 0
      ? Math.trunc(input.horizonDays)
      : MYSTERY_PACK_HORIZON_DAYS;
  const due: MysteryDueSlot[] = [];
  for (const slot of input.slots) {
    const emptyNow = wholePacks(slot.onHand) === 0;
    const isNew = slot.isNew === true;
    if (emptyNow) {
      due.push({ label: slot.label, emptyOn: today, daysLeft: 0, emptyNow: true, isNew });
      continue;
    }
    if (slot.emptyOn === null) continue;
    const daysLeft = Math.max(0, daysBetween(today, slot.emptyOn));
    if (daysLeft > horizon) continue;
    due.push({ label: slot.label, emptyOn: slot.emptyOn, daysLeft, emptyNow: false, isNew });
  }
  due.sort(
    (a, b) => a.daysLeft - b.daysLeft || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
  const batches = Math.max(0, due.length - readyBatches);
  const first = batches > 0 ? (due[readyBatches] ?? null) : null;
  return {
    batches,
    packs: batches * batchSize,
    batchSize,
    readyBatches,
    before: first?.emptyOn ?? null,
    basis: "slots",
    due,
    first,
  };
}

/** Ett antal pack som ett heltal ≥ 0 (minus, null och trasiga tal blir 0). */
function wholePacks(n: number | null | undefined): number {
  if (n === null || n === undefined || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}
