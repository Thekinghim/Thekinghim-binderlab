/**
 * Ekonomin per titel för sidan Inköpspriser, med dagens inköpspris. Ren.
 *
 * "Kvar per order" räknas med det inköpspris som gäller periodens slut (titleEconomics).
 * Butikens andel måste räknas på samma grund: vid vinstdelning (andel av vinsten efter
 * kostnader) beror andelen på inköpet, och liggaren räknar den med de inköpspriser som
 * gällde orderna. Ändrades priset under perioden blev andelen då större eller mindre än
 * avtalets del av "Kvar per order" (50 % av 60,37 kr visades som 32,19 kr). Därför räknas
 * andelen, vår del och förlusten här om med dagens pris på alla titelns order (samma som
 * prisformulärets förhandsvisning), medan snittinköpet och prisets startdag behåller de
 * priser som faktiskt gällde. Order som saknade pris saknar det fortfarande.
 *
 * Förhandsvisningen ("Kvar per order blir …") använder samma räkning med det inskrivna
 * priset, så att den med dagens pris ger exakt tabellens tal.
 */

import {
  titleEconomics,
  type IsoDate,
  type PurchasePrice,
  type TitleEconomics,
  type TitleEconomicsInput,
} from "@/domain";

/**
 * Kvar per order: före butikens andel, andelen (provision eller vinstdelning + hyra) och vår
 * del efter den (öre, null = ingen försäljning).
 */
export interface PerOrderSplit {
  readonly orders: number;
  readonly leftBeforeOre: number | null;
  readonly storeShareOre: number | null;
  readonly leftOre: number | null;
}

/**
 * Priserna med ett enda pris per titel: det som gäller `asOf`, från titelns första pris (så
 * att order före första priset fortfarande saknar pris). Titlar utan pris den dagen behåller
 * sina priser.
 */
function currentPrices(prices: readonly PurchasePrice[], asOf: IsoDate): PurchasePrice[] {
  const byTitle = new Map<string, PurchasePrice[]>();
  for (const p of prices) {
    const list = byTitle.get(p.titleId);
    if (list) list.push(p);
    else byTitle.set(p.titleId, [p]);
  }
  const out: PurchasePrice[] = [];
  for (const [titleId, list] of byTitle) {
    const sorted = list.slice().sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
    const current = sorted.filter((p) => p.validFrom <= asOf).at(-1);
    if (!current) out.push(...sorted);
    else out.push({ titleId, unitCostOre: current.unitCostOre, validFrom: sorted[0]!.validFrom });
  }
  return out;
}

/**
 * titleEconomics där butikens andel, vår del, marginalen på vår del och förlustvarningarna
 * räknas med dagens inköpspris (se filhuvudet). Övriga fält som i titleEconomics.
 */
export function currentPriceEconomics(input: TitleEconomicsInput): TitleEconomics[] {
  const base = titleEconomics(input);
  const asOf = input.asOf ?? input.period.end;
  const flat = new Map(
    titleEconomics({ ...input, prices: currentPrices(input.prices, asOf) }).map((e) => [
      e.titleId,
      e,
    ]),
  );
  return base.map((e) => {
    const f = flat.get(e.titleId);
    if (!f) return e;
    return {
      ...e,
      averageCommissionOre: f.averageCommissionOre,
      storeSharePerOrderOre: f.storeSharePerOrderOre,
      leftPerOrderOre: f.leftPerOrderOre,
      leftPerOrderAfterRentOre: f.leftPerOrderAfterRentOre,
      marginBp: f.marginBp,
      marginAfterRentBp: f.marginAfterRentBp,
      lossWarning: f.lossWarning,
      lossAfterRentWarning: f.lossAfterRentWarning,
    };
  });
}

/**
 * Titelns kvar per order i perioden om `unitCostOre` hade gällt all dess försäljning (som
 * "Rätta priset"). Övriga titlar räknas med dagens pris, som i tabellen (de påverkar
 * butikens vinstdelning).
 */
export function splitWithPrice(
  input: TitleEconomicsInput,
  titleId: string,
  unitCostOre: number,
): PerOrderSplit {
  let from: IsoDate = input.period.start;
  for (const o of input.orders) if (o.businessDate < from) from = o.businessDate;
  const prices = [
    ...input.prices.filter((p) => p.titleId !== titleId),
    { titleId, unitCostOre, validFrom: from },
  ];
  const e = currentPriceEconomics({ ...input, prices, titleIds: [titleId] }).find(
    (r) => r.titleId === titleId,
  );
  return { orders: e?.orders ?? 0, ...perOrderSplit(e ?? null) };
}

/**
 * Kvar per order delat som sidorna visar det: före butikens andel, butikens andel och vår
 * del. Andelen är hela butikernas andel (provision eller vinstdelning + hyra), som i
 * Lönsamhet, och räknas som skillnaden så att kvar före = andel + vår del exakt.
 */
export function perOrderSplit(
  e: Pick<
    TitleEconomics,
    "leftBeforeStoreOre" | "leftPerOrderOre" | "leftPerOrderAfterRentOre"
  > | null,
): Omit<PerOrderSplit, "orders"> {
  const before = e?.leftBeforeStoreOre ?? null;
  const ours = e?.leftPerOrderAfterRentOre ?? e?.leftPerOrderOre ?? null;
  return {
    leftBeforeOre: before,
    storeShareOre: before !== null && ours !== null ? before - ours : null,
    leftOre: ours,
  };
}

/** Kvar per order före och efter ett nytt försäljningspris, och vad det ger på en månad. */
export interface SalePriceEffect {
  /** Order i underlaget (de senaste 30 dagarna). 0 = räknat på ett tänkt pack. */
  readonly orders: number;
  /** Kvar per order före butikens andel (hela beloppet), nu och med det nya priset. */
  readonly beforeOre: number | null;
  readonly afterOre: number | null;
  /** Vår del (efter butikens andel), nu och med det nya priset. */
  readonly shareBeforeOre: number | null;
  readonly shareAfterOre: number | null;
  /** Skillnad i kvar (hela beloppet) på underlagets order, eller null utan försäljning. */
  readonly monthlyDeltaOre: number | null;
  /** Samma för vår del. */
  readonly shareMonthlyDeltaOre: number | null;
}

/**
 * Vad ett nytt försäljningspris (öre, med moms) gör med "Kvar per order", räknat med samma
 * ekonomi som Inköpspriser (currentPriceEconomics: kortavgift, VMB, butikens andel och dagens
 * inköpspris). Varje betald order av titeln i underlaget räknas om till det nya priset
 * (gratis-pack, 0 kr, lämnas som de är); "före" är underlaget som det är, så att det är samma
 * tal som i listan. Utan försäljning räknas ett tänkt pack i `machineId` (null = ingen butik)
 * till nuvarande och nytt pris, och ingen månadseffekt ges.
 */
export function salePriceEffect(
  input: TitleEconomicsInput,
  titleId: string,
  fromOre: number | null,
  toOre: number,
  machineId: string | null = null,
): SalePriceEffect {
  const own = input.orders.filter((o) => o.titleId === titleId && o.amountOre > 0);
  const run = (orders: TitleEconomicsInput["orders"]) =>
    currentPriceEconomics({ ...input, orders, titleIds: [titleId] }).find(
      (e) => e.titleId === titleId,
    ) ?? null;
  const reprice = (ore: number) =>
    input.orders.map((o) =>
      o.titleId === titleId && o.amountOre > 0 ? { ...o, amountOre: ore } : o,
    );

  if (own.length > 0) {
    const before = run(input.orders);
    const after = run(reprice(toOre));
    const totalBefore = before?.leftBeforeStoreTotalOre ?? null;
    const totalAfter = after?.leftBeforeStoreTotalOre ?? null;
    // Vår del efter butikens hela andel (provision eller vinstdelning + hyra), som tabellen.
    const shareBefore = perOrderSplit(before).leftOre;
    const shareAfter = perOrderSplit(after).leftOre;
    return {
      orders: own.length,
      beforeOre: before?.leftBeforeStoreOre ?? null,
      afterOre: after?.leftBeforeStoreOre ?? null,
      shareBeforeOre: shareBefore,
      shareAfterOre: shareAfter,
      monthlyDeltaOre:
        totalBefore !== null && totalAfter !== null ? totalAfter - totalBefore : null,
      shareMonthlyDeltaOre:
        shareBefore !== null && shareAfter !== null
          ? (shareAfter - shareBefore) * (before?.orders ?? 0)
          : null,
    };
  }

  // Ingen försäljning: ett tänkt pack sista dagen i underlaget.
  const one = (ore: number) =>
    run([
      ...input.orders,
      {
        id: "binderlab:tankt-pack",
        externalId: "binderlab:tankt-pack",
        titleId,
        machineId,
        businessDate: input.period.end,
        amountOre: ore,
      },
    ]);
  const before = fromOre === null ? null : one(fromOre);
  const after = one(toOre);
  return {
    orders: 0,
    beforeOre: before?.leftBeforeStoreOre ?? null,
    afterOre: after?.leftBeforeStoreOre ?? null,
    shareBeforeOre: perOrderSplit(before).leftOre,
    shareAfterOre: perOrderSplit(after).leftOre,
    monthlyDeltaOre: null,
    shareMonthlyDeltaOre: null,
  };
}
