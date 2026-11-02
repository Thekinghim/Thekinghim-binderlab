/**
 * Hyra per butik och kalendermånad.
 *
 * För varje butik och varje kalendermånad som perioden berör:
 *
 *   hyra = round( Σ (månadshyra_a × dagar_a) / dagar i månaden )
 *
 * där summan går över de avtal a som gällde någon dag i månaden inom perioden, och
 * dagar_a är antalet sådana dagar. Med ett enda avtal blir det precis
 * round(månadshyra × överlappsdagar / dagar i månaden). Byts avtalet mitt i månaden
 * vägs hyrorna efter dagar, och avrundningen sker en gång per butik och månad.
 * En hel månad med samma avtal ger alltså exakt månadshyran.
 *
 * Hyran gäller enligt avtalet, oavsett om någon automat stod i butiken eller sålde.
 */

import {
  assertPeriod,
  daysInMonth,
  eachMonth,
  maxDate,
  minDate,
  monthEnd,
  monthStart,
} from "./dates";
import { DomainError } from "./errors";
import { roundHalfUp } from "./money";
import { AgreementIndex } from "./placements";
import type { IsoDate, IsoMonth, Period, StoreAgreement } from "./types";

/** Del av en butik-månad där ett visst avtal gällde. */
export interface RentSegment {
  readonly validFrom: IsoDate;
  readonly monthlyRentOre: number;
  /** Första och sista dag i segmentet (inom perioden och månaden). */
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly days: number;
}

/** Hyran för en butik under en kalendermånad (den del som ligger i perioden). */
export interface StoreMonthRent {
  readonly storeId: string;
  readonly month: IsoMonth;
  /** Avrundad hyra i öre för dagarna inom perioden. */
  readonly rentOre: number;
  /** Antal dagar med hyresavtal inom perioden. */
  readonly days: number;
  readonly daysInMonth: number;
  readonly segments: readonly RentSegment[];
}

/**
 * Hyra per (butik, månad) inom perioden, sorterad på butik och månad.
 * Butik-månader utan hyra (inget avtal, bara provision, eller hyra 0) tas inte med.
 */
export function rentByStoreMonth(
  agreements: readonly StoreAgreement[] | AgreementIndex,
  period: Period,
): StoreMonthRent[] {
  assertPeriod(period);
  const index = agreements instanceof AgreementIndex ? agreements : new AgreementIndex(agreements);
  const acc = new Map<
    string,
    { storeId: string; month: IsoMonth; numerator: bigint; days: number; segments: RentSegment[] }
  >();

  for (const a of index.all()) {
    const rent = a.monthlyRentOre ?? 0;
    if (rent === 0) continue;
    const start = maxDate(a.validFrom, period.start);
    const end = a.validTo === null ? period.end : minDate(a.validTo, period.end);
    if (end < start) continue;
    for (const month of eachMonth(start, end)) {
      const segStart = maxDate(start, monthStart(month));
      const segEnd = minDate(end, monthEnd(month));
      const days = Number(segEnd.slice(8)) - Number(segStart.slice(8)) + 1;
      const key = `${a.storeId}\u0000${month}`;
      let row = acc.get(key);
      if (!row) {
        row = { storeId: a.storeId, month, numerator: 0n, days: 0, segments: [] };
        acc.set(key, row);
      }
      row.numerator += BigInt(rent) * BigInt(days);
      row.days += days;
      row.segments.push({
        validFrom: a.validFrom,
        monthlyRentOre: rent,
        start: segStart,
        end: segEnd,
        days,
      });
    }
  }

  const out: StoreMonthRent[] = [];
  for (const row of acc.values()) {
    const dim = daysInMonth(row.month);
    if (row.days > dim) {
      // Kan bara hända om avtalen överlappar, vilket AgreementIndex redan stoppar.
      throw new DomainError(
        "overlapping_agreement",
        `Butik ${row.storeId} har överlappande avtal.`,
      );
    }
    row.segments.sort((x, y) => (x.start < y.start ? -1 : 1));
    out.push({
      storeId: row.storeId,
      month: row.month,
      rentOre: roundHalfUp(row.numerator, BigInt(dim)),
      days: row.days,
      daysInMonth: dim,
      segments: row.segments,
    });
  }
  out.sort((x, y) =>
    x.storeId < y.storeId ? -1 : x.storeId > y.storeId ? 1 : x.month < y.month ? -1 : 1,
  );
  return out;
}
