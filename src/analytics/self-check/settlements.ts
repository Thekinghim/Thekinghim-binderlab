/**
 * Kontroll 5, "Avräkningar": för varje obetald avräkning för en stängd månad räknas
 * beloppet nu (avräkningsmotorn, src/server/settlements/live.ts) och jämförs med butikens
 * andel för samma månad på sidorna (Lönsamhet per butik med butikernas andel). Det
 * butiken ska få ska vara det sidorna visar som butikens andel, på öret.
 *
 * Det sparade beloppet på raden räknas om varje natt (larmjobbet) och alla sidor visar
 * det nu räknade beloppet; ett sparat belopp som inte uppdaterats än är en varning, inget
 * fel. En avräkning som inte går att räkna (t.ex. order utan inköpspris under
 * vinstdelning) är ett fel.
 */

import { countText, diffKr, kr, resultOf, skipped } from "./common";
import type { CheckFinding, CheckResult } from "./types";

export interface SettlementRow {
  readonly storeName: string;
  /** "oktober 2026" */
  readonly monthLabel: string;
  readonly storedOre: number;
  /** Beloppet räknat nu, eller varför det inte går. */
  readonly live:
    | { readonly ok: true; readonly amountOre: number }
    | { readonly ok: false; readonly message: string };
  /** Butikens andel för månaden på sidorna (Lönsamhet per butik, med andelen). */
  readonly pageShareOre: number;
}

export function settlementCheck(rows: readonly SettlementRow[]): CheckResult {
  if (rows.length === 0) {
    return skipped("avrakningar", "Inga obetalda avräkningar för stängda månader.");
  }
  const findings: CheckFinding[] = [];
  let wrong = 0;
  for (const r of rows) {
    const where = `${r.storeName}, ${r.monthLabel}`;
    if (!r.live.ok) {
      wrong += 1;
      findings.push({
        level: "fail",
        text: `${where}: avräkningen går inte att räkna: ${r.live.message}`,
      });
      continue;
    }
    if (r.live.amountOre !== r.pageShareOre) {
      wrong += 1;
      findings.push({
        level: "fail",
        text: `${where}: avräkningen är ${kr(r.live.amountOre)}, butikens andel på sidorna ${kr(r.pageShareOre)} (${diffKr(r.live.amountOre - r.pageShareOre)}).`,
      });
    }
    if (r.storedOre !== r.live.amountOre) {
      findings.push({
        level: "warn",
        text: `${where}: sparat belopp ${kr(r.storedOre)}, räknat nu ${kr(r.live.amountOre)}. Sidorna visar det räknade; det sparade uppdateras i natt.`,
      });
    }
  }
  const total = rows.reduce((n, r) => n + (r.live.ok ? r.live.amountOre : 0), 0);
  return resultOf("avrakningar", {
    findings,
    figures: [
      { label: "Obetalda avräkningar", value: rows.length, unit: "count" },
      { label: "Att betala", value: total, unit: "ore" },
    ],
    summary: {
      pass: `${countText(rows.length, "obetald avräkning", "obetalda avräkningar")} stämmer med butikernas andel (${kr(total)}).`,
      warn: "Beloppen stämmer; något sparat belopp uppdateras i natt.",
      fail: `${countText(wrong, "avräkning", "avräkningar")} stämmer inte med butikens andel.`,
    },
  });
}
