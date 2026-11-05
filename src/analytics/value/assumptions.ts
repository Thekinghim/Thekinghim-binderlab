/**
 * Antagandena bakom "Vad Binderlab gett dig" (/varde), samlade på ett ställe. Sidan och
 * månadsrapporten visar dem som de står här, så att ägaren alltid ser vad siffrorna bygger
 * på. Ändras ett värde här ändras det överallt (och i docs/berakningar.md, avsnitt 27).
 *
 * Minuterna är medvetet försiktiga: tiden det tar att göra samma sak för hand en vanlig
 * dag, utan restid och utan att räkna med misstag som Binderlab förhindrar.
 */

/** Uppgifter som Binderlab gör eller förenklar, och som räknas som sparad tid. */
export type AutomationKind =
  "refill_visit" | "awish_push" | "settlement" | "bookkeeping" | "alert" | "report";

export interface TaskAssumption {
  readonly kind: AutomationKind;
  /** Kort namn i tabellen ("Påfyllning registrerad"). */
  readonly label: string;
  /** Minuter som sparas per gång. Heltal. */
  readonly minutes: number;
  /** Vad som annars görs för hand (visas som antagande). */
  readonly instead: string;
  /** Vad som räknas som en gång. */
  readonly unit: string;
}

/** Minuter per uppgift. Ordningen är tabellens ordning. */
export const TASK_ASSUMPTIONS: readonly TaskAssumption[] = [
  {
    kind: "refill_visit",
    label: "Påfyllning registrerad",
    minutes: 5,
    instead: "skriva upp vad som fylldes på och räkna lagret för hand",
    unit: "automat och dag med påfyllning",
  },
  {
    kind: "awish_push",
    label: "Awish uppdaterad",
    minutes: 3,
    instead: "logga in på Awish och skriva in antal per fack",
    unit: "automat som skickades till Awish",
  },
  {
    kind: "settlement",
    label: "Butiksavräkning",
    minutes: 20,
    instead: "räkna ut butikens andel i Excel",
    unit: "butik och månad",
  },
  {
    kind: "bookkeeping",
    label: "Bokföringsunderlag",
    minutes: 60,
    instead: "sammanställa försäljning och inköp till bokföringen",
    unit: "månadspaket",
  },
  {
    kind: "alert",
    label: "Larm skickat",
    minutes: 5,
    instead: "själv kolla om en automat står still",
    unit: "skickat larm",
  },
  {
    kind: "report",
    label: "Rapport till butik",
    minutes: 15,
    instead: "ta fram och mejla siffror till butiken",
    unit: "skickad rapport",
  },
];

/** Antagandet för en uppgift. */
export function taskAssumption(kind: AutomationKind): TaskAssumption {
  const found = TASK_ASSUMPTIONS.find((t) => t.kind === kind);
  if (!found) throw new Error(`Okänd uppgift: ${kind}`);
  return found;
}

/**
 * Påfyllning i tid: hur många dagar efter att facket hade blivit tomt som försäljningen
 * räknas som räddad. Antagandet är att någon annars hade fyllt på inom en vecka; försäljning
 * senare än så räknas inte (försiktigt).
 */
export const SAVED_SALES_MAX_DAYS = 7;

/** Antal månader bakåt som utvecklingen visar (vald månad inräknad). */
export const TREND_MONTHS = 6;

/** Minsta antal prissatta order innan en titel med förlust föreslås få höjt pris. */
export const PRICE_ACTION_MIN_ORDERS = 3;
