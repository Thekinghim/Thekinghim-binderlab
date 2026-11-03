/**
 * Placeringar (vilken butik en automat stod i) och butiksavtal, båda versionerade
 * med datumintervall. Intervallen är inklusive i båda ändar och får inte överlappa
 * (samma regel som exclusion constraints i databasen).
 */

import { assertIsoDate } from "./dates";
import { DomainError, type DomainErrorCode } from "./errors";
import { assertBp, assertNonNegativeInteger } from "./money";
import type { IsoDate, Placement, StoreAgreement } from "./types";

interface IntervalAccess<T> {
  from(item: T): IsoDate;
  to(item: T): IsoDate | null;
}

/** Sorterade, icke-överlappande intervall per nyckel med binärsökning. */
class IntervalIndex<T> {
  private readonly byKey = new Map<string, T[]>();

  constructor(
    items: readonly T[],
    private readonly keyOf: (item: T) => string,
    private readonly access: IntervalAccess<T>,
    overlapCode: DomainErrorCode,
    describe: (key: string, a: T, b: T) => string,
  ) {
    for (const item of items) {
      const key = keyOf(item);
      const list = this.byKey.get(key);
      if (list) list.push(item);
      else this.byKey.set(key, [item]);
    }
    for (const [key, list] of this.byKey) {
      list.sort((a, b) => {
        const fa = access.from(a);
        const fb = access.from(b);
        return fa < fb ? -1 : fa > fb ? 1 : 0;
      });
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1]!;
        const cur = list[i]!;
        const prevTo = access.to(prev);
        if (prevTo === null || prevTo >= access.from(cur)) {
          throw new DomainError(overlapCode, describe(key, prev, cur));
        }
      }
    }
  }

  find(key: string, date: IsoDate): T | null {
    const list = this.byKey.get(key);
    if (!list) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.access.from(list[mid]!) <= date) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return null;
    const item = list[found]!;
    const to = this.access.to(item);
    return to === null || date <= to ? item : null;
  }

  list(key: string): readonly T[] {
    return this.byKey.get(key) ?? [];
  }

  keys(): string[] {
    return [...this.byKey.keys()];
  }

  all(): T[] {
    return [...this.byKey.values()].flat();
  }
}

// ---------------------------------------------------------------------------
// Placeringar
// ---------------------------------------------------------------------------

function validatePlacement(p: Placement): void {
  if (!p || typeof p.machineId !== "string" || p.machineId === "") {
    throw new DomainError("invalid_input", "Placeringen saknar automat.");
  }
  if (typeof p.storeId !== "string" || p.storeId === "") {
    throw new DomainError("invalid_input", `Placeringen av automat ${p.machineId} saknar butik.`);
  }
  assertIsoDate(p.from, `Placeringens startdatum (automat ${p.machineId})`);
  if (p.to !== null) {
    assertIsoDate(p.to, `Placeringens slutdatum (automat ${p.machineId})`);
    if (p.to < p.from) {
      throw new DomainError(
        "invalid_period",
        `Placeringen av automat ${p.machineId} slutar ${p.to}, före start ${p.from}.`,
      );
    }
  }
}

/** Uppslag: i vilken butik stod automaten en viss dag? */
export class PlacementIndex {
  private readonly index: IntervalIndex<Placement>;

  constructor(placements: readonly Placement[]) {
    for (const p of placements) validatePlacement(p);
    this.index = new IntervalIndex(
      placements,
      (p) => p.machineId,
      { from: (p) => p.from, to: (p) => p.to },
      "overlapping_placement",
      (machineId, a, b) =>
        `Automat ${machineId} har överlappande placeringar (${a.from}–${a.to ?? "tills vidare"} och ${b.from}–${b.to ?? "tills vidare"}).`,
    );
  }

  /** Placeringen som gällde `date`, eller `null`. */
  placementOn(machineId: string, date: IsoDate): Placement | null {
    return this.index.find(machineId, date);
  }

  /** Butiken där automaten stod `date`, eller `null`. */
  storeOn(machineId: string, date: IsoDate): string | null {
    return this.index.find(machineId, date)?.storeId ?? null;
  }

  /** Alla placeringar för automaten, äldst först. */
  placementsFor(machineId: string): readonly Placement[] {
    return this.index.list(machineId);
  }

  /** Automater som har minst en placering. */
  machineIds(): string[] {
    return this.index.keys();
  }
}

/**
 * Butiken där automaten stod ett visst datum, eller `null` om automaten saknas,
 * är okänd eller inte var placerad den dagen.
 */
export function storeOn(
  placements: readonly Placement[] | PlacementIndex,
  machineId: string | null,
  date: IsoDate,
): string | null {
  assertIsoDate(date);
  if (machineId === null) return null;
  const index = placements instanceof PlacementIndex ? placements : new PlacementIndex(placements);
  return index.storeOn(machineId, date);
}

// ---------------------------------------------------------------------------
// Butiksavtal
// ---------------------------------------------------------------------------

function validateAgreement(a: StoreAgreement): void {
  if (!a || typeof a.storeId !== "string" || a.storeId === "") {
    throw new DomainError("invalid_input", "Avtalet saknar butik.");
  }
  assertIsoDate(a.validFrom, `Avtalets startdatum (butik ${a.storeId})`);
  if (a.validTo !== null) {
    assertIsoDate(a.validTo, `Avtalets slutdatum (butik ${a.storeId})`);
    if (a.validTo < a.validFrom) {
      throw new DomainError(
        "invalid_period",
        `Avtalet för butik ${a.storeId} slutar ${a.validTo}, före start ${a.validFrom}.`,
      );
    }
  }
  if (a.commissionBp !== null) assertBp(a.commissionBp, `Provisionen (butik ${a.storeId})`);
  if (a.monthlyRentOre !== null) {
    assertNonNegativeInteger(a.monthlyRentOre, `Månadshyran (butik ${a.storeId})`);
  }
  if (
    a.commissionBase !== undefined &&
    a.commissionBase !== "net_excl_vat" &&
    a.commissionBase !== "profit_after_costs"
  ) {
    throw new DomainError("invalid_input", `Avtalet för butik ${a.storeId} har okänt underlag.`);
  }
  if (
    a.lossTreatment !== undefined &&
    a.lossTreatment !== "zero" &&
    a.lossTreatment !== "proportional"
  ) {
    throw new DomainError(
      "invalid_input",
      `Avtalet för butik ${a.storeId} har okänd förlusthantering.`,
    );
  }
}

/** Uppslag: vilket avtal gällde för butiken en viss dag? */
export class AgreementIndex {
  private readonly index: IntervalIndex<StoreAgreement>;

  constructor(agreements: readonly StoreAgreement[]) {
    for (const a of agreements) validateAgreement(a);
    this.index = new IntervalIndex(
      agreements,
      (a) => a.storeId,
      { from: (a) => a.validFrom, to: (a) => a.validTo },
      "overlapping_agreement",
      (storeId, a, b) =>
        `Butik ${storeId} har överlappande avtal (${a.validFrom}–${a.validTo ?? "tills vidare"} och ${b.validFrom}–${b.validTo ?? "tills vidare"}).`,
    );
  }

  /** Avtalet som gällde `date`, eller `null`. */
  agreementOn(storeId: string, date: IsoDate): StoreAgreement | null {
    return this.index.find(storeId, date);
  }

  /** Alla avtal för butiken, äldst först. */
  agreementsFor(storeId: string): readonly StoreAgreement[] {
    return this.index.list(storeId);
  }

  /** Alla avtal. */
  all(): StoreAgreement[] {
    return this.index.all();
  }
}

/** Avtalet som gällde för butiken ett visst datum, eller `null`. */
export function agreementOn(
  agreements: readonly StoreAgreement[] | AgreementIndex,
  storeId: string,
  date: IsoDate,
): StoreAgreement | null {
  assertIsoDate(date);
  const index = agreements instanceof AgreementIndex ? agreements : new AgreementIndex(agreements);
  return index.agreementOn(storeId, date);
}
