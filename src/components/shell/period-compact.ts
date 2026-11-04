/**
 * Periodraden på mobilen: en knapp med vald period och datum ("30 dagar · 6 okt. – 4 nov.")
 * i stället för sju knappar och två datumrader. Ren funktion, testas i period-compact.test.ts.
 */

import { periodChoices, type PeriodKey } from "./period-state";

export interface CompactPeriod {
  /** Periodens namn: "30 dagar", "Denna månad", "Eget". */
  readonly name: string;
  /** Datumen, t.ex. "6 okt. – 4 nov.". */
  readonly range: string;
  /** Hela texten för skärmläsare. */
  readonly label: string;
}

export function compactPeriod(key: PeriodKey, rangeLabel: string): CompactPeriod {
  const choice = periodChoices.find((c) => c.key === key);
  const name = key === "eget" ? (choice?.short ?? "Eget") : (choice?.label ?? rangeLabel);
  // "I dag" och ett eget intervall på en dag säger samma sak två gånger annars.
  const range = rangeLabel === name ? "" : rangeLabel;
  return { name, range, label: range ? `Period: ${name}, ${range}` : `Period: ${name}` };
}
