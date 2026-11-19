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
 *
 * Betalda avräkningar (de senaste tolv månaderna) räknas också om: är månadens belopp med
 * dagens underlag ett annat än det som betalades, och skillnaden inte är lagd som rättelse
 * på en senare avräkning, är det en varning: "Betald avräkning skiljer sig från dagens
 * uträkning". Det betalda beloppet ändras aldrig; skillnaden rättas på nästa avräkning.
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
  /** Rättelser som ligger på avräkningen och ingår i beloppet (inte i butikens andel). */
  readonly correctionsOre?: number;
}

/** En betald avräkning med månadens belopp räknat nu. */
export interface PaidSettlementRow {
  readonly storeName: string;
  /** "oktober 2026" */
  readonly monthLabel: string;
  /** Det som betalades. */
  readonly paidOre: number;
  /** Månadens belopp med dagens underlag, eller null (går inte att räkna nu). */
  readonly liveOre: number | null;
  /** Skillnad som redan lagts som rättelse på en senare avräkning. */
  readonly correctedOre: number;
}

/** Rubriken för regeln om betalda avräkningar (samma som punkten i Att göra). */
export const PAID_DRIFT_TITLE = "Betald avräkning skiljer sig från dagens uträkning";

export function settlementCheck(
  rows: readonly SettlementRow[],
  paid: readonly PaidSettlementRow[] = [],
): CheckResult {
  if (rows.length === 0 && paid.length === 0) {
    return skipped("avrakningar", "Inga obetalda avräkningar för stängda månader.");
  }
  const findings: CheckFinding[] = [];
  let wrong = 0;
  let drifted = 0;
  for (const p of paid) {
    if (p.liveOre === null) continue;
    const diff = p.liveOre - p.paidOre - p.correctedOre;
    if (diff === 0) continue;
    drifted += 1;
    findings.push({
      level: "warn",
      text: `${PAID_DRIFT_TITLE}: ${p.storeName}, ${p.monthLabel}. Betalt ${kr(p.paidOre)}, dagens uträkning ${kr(p.liveOre)} (${diffKr(diff)}). Lägg skillnaden på nästa avräkning under Butiker → Utbetalning.`,
    });
  }
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
    // Rättelser för tidigare månader ingår i beloppet men inte i månadens andel.
    const monthOre = r.live.amountOre - (r.correctionsOre ?? 0);
    if (monthOre !== r.pageShareOre) {
      wrong += 1;
      findings.push({
        level: "fail",
        text: `${where}: avräkningen är ${kr(monthOre)}, butikens andel på sidorna ${kr(r.pageShareOre)} (${diffKr(monthOre - r.pageShareOre)}).`,
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
      { label: "Betalda som skiljer sig", value: drifted, unit: "count" },
    ],
    summary: {
      pass:
        rows.length === 0
          ? `${countText(paid.length, "betald avräkning", "betalda avräkningar")} stämmer med dagens uträkning.`
          : `${countText(rows.length, "obetald avräkning", "obetalda avräkningar")} stämmer med butikernas andel (${kr(total)}).`,
      warn:
        drifted > 0
          ? `${countText(drifted, "betald avräkning", "betalda avräkningar")} skiljer sig från dagens uträkning.`
          : "Beloppen stämmer; något sparat belopp uppdateras i natt.",
      fail: `${countText(wrong, "avräkning", "avräkningar")} stämmer inte med butikens andel.`,
    },
  });
}
