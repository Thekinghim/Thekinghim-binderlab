/**
 * Släppkurvor: hur tidigare släpp sålt de första veckorna.
 *
 * Släppdag: `releaseDate` om den anges, annars dagen för titelns första order. Order före
 * släppdagen räknas inte.
 *
 * Profil per släpp (horisont H dagar, standard 28):
 * - pack per dag d = 0 … H − 1 efter släppdagen, alla automater,
 * - pack per automat för automater som var i drift hela horisonten (0 om de inte sålde
 *   titeln; en automat som inte fick titeln drar alltså ned, vilket speglar verkligheten),
 * - komplett när släppdag + H − 1 ≤ asOf. Bara kompletta släpp används i förslag och kurva.
 *
 * Normaliserad släppkurva: för varje släpp andelen av horisontens försäljning som sålts till
 * och med dag d; kurvan är medelvärdet av släppens andelar (varje släpp väger lika, oavsett
 * storlek), i bp. Sista dagen är alltid 10 000. Veckoandelar = skillnaden mellan veckornas
 * slutvärden, så att de summerar till exakt 10 000.
 */

import {
  addDays,
  assertIsoDate,
  daysBetween,
  DomainError,
  type IsoDate,
  type OrderLine,
} from "@/domain";
import { fig, Ratio } from "../expansion/common";
import { isMachineActive, nameLookup } from "../todos/common";
import type { MachineRef } from "../todos/types";
import {
  bpOf,
  compareStrings,
  listText,
  marketEvidence,
  pctAbs,
  type MarketEvidence,
} from "../pricing/common";
import type { NamedRef } from "../pricing/market";

/** Ett släpp (en titel). */
export interface ReleaseRef {
  readonly titleId: string;
  /** Serie, t.ex. "Scarlet & Violet". Släpp i samma serie föredras som jämförelse. */
  readonly series?: string | null;
  /** Officiell släppdag. `null`/saknas = dagen för första order. */
  readonly releaseDate?: IsoDate | null;
}

/** Indata för släpphistoriken. */
export interface ReleaseHistoryInput {
  readonly orders: readonly OrderLine[];
  readonly releases: readonly ReleaseRef[];
  readonly machines: readonly MachineRef[];
  /** Sista dag med data. */
  readonly asOf: IsoDate;
  /** Horisont i dagar. Standard 28 (4 veckor). */
  readonly horizonDays?: number;
  readonly titles?: readonly NamedRef[];
}

/** Ett släpps försäljning de första dagarna. */
export interface ReleaseProfile {
  readonly titleId: string;
  readonly series: string | null;
  readonly launchDate: IsoDate;
  readonly launchSource: "given" | "first-sale";
  /** Sant när hela horisonten ligger till och med asOf. */
  readonly complete: boolean;
  /** Dagar med data (≤ H). */
  readonly observedDays: number;
  /** Pack per dag från släppdagen. */
  readonly dailyUnits: readonly number[];
  readonly totalUnits: number;
  /** Automater i drift hela horisonten, med sålda pack (0 om inga). Sorterade på id. */
  readonly machines: readonly { readonly machineId: string; readonly units: number }[];
  /** Andel sålt till och med varje dag, i bp. `null` om inget sålts. */
  readonly cumulativeBp: readonly number[] | null;
  readonly orderIds: readonly string[];
}

/** Normaliserad släppkurva. */
export interface ReleaseCurve {
  readonly horizonDays: number;
  readonly titleIds: readonly string[];
  /** Andel sålt till och med dag d (d = 0 … H − 1), i bp. Sista = 10 000. */
  readonly cumulativeBp: readonly number[];
  /** Andel per vecka (sista veckan kan vara kortare), i bp. Summerar till 10 000. */
  readonly weeklyBp: readonly number[];
  readonly text: string;
  readonly evidence: MarketEvidence;
}

/** Kontrollerar och returnerar horisonten. */
export function horizonOf(value: number | undefined): number {
  const h = value ?? 28;
  if (!Number.isSafeInteger(h) || h < 1) {
    throw new DomainError("invalid_input", `Horisonten måste vara ett heltal ≥ 1, fick ${h}.`);
  }
  return h;
}

/**
 * Profil per släpp (se modulens beskrivning), sorterad på släppdag och titel. Släpp utan
 * angiven dag och utan order hoppas över (släppdagen är okänd).
 */
export function releaseProfiles(input: ReleaseHistoryInput): ReleaseProfile[] {
  assertIsoDate(input.asOf, "Sista dag med data");
  const H = horizonOf(input.horizonDays);
  const byTitle = new Map<string, OrderLine[]>();
  for (const o of input.orders) {
    assertIsoDate(o.businessDate, `Affärsdatum för order ${o.id}`);
    if (o.businessDate > input.asOf) continue;
    const list = byTitle.get(o.titleId);
    if (list) list.push(o);
    else byTitle.set(o.titleId, [o]);
  }
  const seen = new Set<string>();
  const out: ReleaseProfile[] = [];
  for (const r of input.releases) {
    if (seen.has(r.titleId)) {
      throw new DomainError("invalid_input", `Släppet ${r.titleId} förekommer två gånger.`);
    }
    seen.add(r.titleId);
    const orders = byTitle.get(r.titleId) ?? [];
    let launchDate: IsoDate;
    let launchSource: ReleaseProfile["launchSource"];
    if (r.releaseDate) {
      assertIsoDate(r.releaseDate, `Släppdag för ${r.titleId}`);
      launchDate = r.releaseDate;
      launchSource = "given";
    } else {
      if (orders.length === 0) continue;
      launchDate = orders.reduce(
        (m, o) => (o.businessDate < m ? o.businessDate : m),
        orders[0]!.businessDate,
      );
      launchSource = "first-sale";
    }
    if (launchDate > input.asOf) continue;
    const lastDay = addDays(launchDate, H - 1);
    const complete = lastDay <= input.asOf;
    const observedDays = complete ? H : daysBetween(launchDate, input.asOf) + 1;
    const end = addDays(launchDate, observedDays - 1);
    const daily = new Array<number>(observedDays).fill(0);
    const perMachine = new Map<string, number>();
    const orderIds: string[] = [];
    for (const o of orders) {
      if (o.businessDate < launchDate || o.businessDate > end) continue;
      const d = daysBetween(launchDate, o.businessDate);
      daily[d] = daily[d]! + 1;
      orderIds.push(o.id);
      if (o.machineId !== null) perMachine.set(o.machineId, (perMachine.get(o.machineId) ?? 0) + 1);
    }
    const machines = input.machines
      .filter((m) => isMachineActive(m, launchDate) && isMachineActive(m, lastDay))
      .map((m) => ({ machineId: m.id, units: perMachine.get(m.id) ?? 0 }))
      .sort((a, b) => compareStrings(a.machineId, b.machineId));
    const totalUnits = daily.reduce((s, u) => s + u, 0);
    let cumulativeBp: number[] | null = null;
    if (totalUnits > 0) {
      cumulativeBp = [];
      let acc = 0;
      for (const u of daily) {
        acc += u;
        cumulativeBp.push(bpOf(new Ratio(acc, totalUnits)));
      }
    }
    out.push({
      titleId: r.titleId,
      series: r.series ?? null,
      launchDate,
      launchSource,
      complete,
      observedDays,
      dailyUnits: daily,
      totalUnits,
      machines,
      cumulativeBp,
      orderIds: orderIds.sort(compareStrings),
    });
  }
  return out.sort((a, b) =>
    a.launchDate !== b.launchDate
      ? a.launchDate < b.launchDate
        ? -1
        : 1
      : compareStrings(a.titleId, b.titleId),
  );
}

/**
 * Normaliserad släppkurva av kompletta släpp med försäljning (se modulens beskrivning).
 * `null` när inget sådant släpp finns. Exempel: två släpp som sålt 50 % och 30 % första
 * veckan ger 40 % första veckan.
 */
export function releaseCurve(
  profiles: readonly ReleaseProfile[],
  horizonDays?: number,
  titles: readonly NamedRef[] = [],
): ReleaseCurve | null {
  const H = horizonOf(horizonDays);
  const used = profiles.filter((p) => p.complete && p.totalUnits > 0 && p.dailyUnits.length === H);
  if (used.length === 0) return null;
  const cumulativeBp: number[] = [];
  const acc = used.map(() => 0);
  for (let d = 0; d < H; d++) {
    let sum = new Ratio(0);
    used.forEach((p, i) => {
      acc[i] = acc[i]! + p.dailyUnits[d]!;
      sum = sum.add(new Ratio(acc[i]!, p.totalUnits));
    });
    cumulativeBp.push(bpOf(sum.div(used.length)));
  }
  const weeklyBp: number[] = [];
  let prev = 0;
  for (let end = 7; end < H + 7; end += 7) {
    const idx = Math.min(end, H) - 1;
    weeklyBp.push(cumulativeBp[idx]! - prev);
    prev = cumulativeBp[idx]!;
  }
  const name = nameLookup(titles);
  const firstWeek = weeklyBp[0]!;
  return {
    horizonDays: H,
    titleIds: used.map((p) => p.titleId),
    cumulativeBp,
    weeklyBp,
    text: `Tidigare släpp (${listText(used.map((p) => name(p.titleId)))}) sålde i snitt ${pctAbs(firstWeek)} av de första ${H} dagarnas försäljning under första veckan.`,
    evidence: marketEvidence({
      rule: `Andel av försäljningen de första ${H} dagarna som sålts till och med varje dag; medelvärde av släppen, varje släpp väger lika.`,
      orderIds: used.flatMap((p) => p.orderIds),
      dates: used.map((p) => p.launchDate),
      titleIds: used.map((p) => p.titleId),
      figures: [
        fig("releases", "Släpp i kurvan", used.length, "count"),
        fig("horizonDays", "Horisont", H, "days"),
        ...weeklyBp.map((w, i) => fig(`week${i + 1}Bp`, `Andel vecka ${i + 1}`, w, "bp")),
      ],
    }),
  };
}
