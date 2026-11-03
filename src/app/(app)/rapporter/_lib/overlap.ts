/**
 * Varning när ett bokföringsunderlag med eget datum överlappar ett annat underlag för samma
 * dagar: månadspaketet under Bokföring (finns för varje avslutad månad) eller ett arkiverat
 * bokföringsunderlag. Båda innehåller samma verifikationer, så de får inte importeras båda.
 *
 *   "Överlappar oktoberpaketet – importera inte båda."
 *
 * Ren funktion: allt kommer från sidans redan lästa data (arkivet, valet och dagens datum).
 */

import { periodText } from "@/reports/text";

const MONTHS = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
] as const;

interface Range {
  readonly start: string;
  readonly end: string;
}

export interface OverlapInput {
  readonly type: string;
  /** Eget datum som visas, eller null för hela månaden. */
  readonly range: Range | null;
  /** Vald månad (ÅÅÅÅ-MM) när inget eget datum visas. */
  readonly month: string;
  /** Affärsdagen i dag (ÅÅÅÅ-MM-DD). */
  readonly today: string;
  readonly archive: ReadonlyArray<{
    readonly type: string;
    readonly custom: boolean;
    readonly period: Range;
  }>;
}

const WARNING = "importera inte båda.";

function monthsIn(r: Range): string[] {
  const out: string[] = [];
  let [y, m] = r.start.slice(0, 7).split("-").map(Number) as [number, number];
  const last = r.end.slice(0, 7);
  for (let guard = 0; guard < 24; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= last) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function overlaps(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function monthWord(key: string): string {
  return MONTHS[Number(key.slice(5, 7)) - 1] ?? key;
}

/** "oktoberpaketet", "oktober- och novemberpaketet", "september-, oktober- och novemberpaketet". */
function packageText(months: readonly string[]): string {
  const words = months.map(monthWord);
  if (words.length === 1) return `${words[0]}paketet`;
  const head = words.slice(0, -1).map((w) => `${w}-`);
  return `${head.join(", ")} och ${words[words.length - 1]}paketet`;
}

export function bookkeepingOverlap(input: OverlapInput): string | null {
  if (input.type !== "bokforing") return null;
  const thisMonth = input.today.slice(0, 7);

  if (input.range) {
    const own = input.range;
    // Månadspaketen finns för avslutade månader.
    const closed = monthsIn(own).filter((m) => m < thisMonth);
    if (closed.length > 0) return `Överlappar ${packageText(closed)} – ${WARNING}`;
    const other = input.archive.find(
      (r) =>
        r.type === "bokforing" &&
        overlaps(r.period, own) &&
        !(r.period.start === own.start && r.period.end === own.end),
    );
    return other ? `Överlappar underlaget ${periodText(other.period)} – ${WARNING}` : null;
  }

  // Hela månaden: ett arkiverat underlag med eget datum inom månaden.
  const month: Range = { start: `${input.month}-01`, end: `${input.month}-31` };
  const custom = input.archive.find(
    (r) => r.type === "bokforing" && r.custom && overlaps(r.period, month),
  );
  return custom ? `Överlappar underlaget ${periodText(custom.period)} – ${WARNING}` : null;
}
