/**
 * Hur en utbetalning från Nayax delas: butikerna, partnern, momsen att spara och det som
 * blir kvar till ägaren (Pengar → Utbetalningar). Ren funktion, allt i hela öre.
 *
 * Pengarna in bestämmer allt. Beloppet från Nayax är redan efter Nayax avgifter och
 * återbetalningar, så avgifterna behövs inte för delningen (de visas bara som förklaring):
 *
 *   butiker   = Σ butikens andel för dagarna + justeringar             (regel 1)
 *   inköp     = Σ vårt inköpspris för sålda pack (om partnern får tillbaka inköpet)  (2)
 *   moms      = momsen att spara (vat-reserve.ts)                       (3)
 *   vinst     = belopp − butiker − inköp − moms        (kan vara negativ) (4)
 *   vinstdel  = vinst × andel / 10 000, avkortat mot noll                (5)
 *   partner   = inköp + vinstdel (+ förra utbetalningens skuld)          (6)
 *   ägaren    = belopp − butiker − partner − moms                        (6)
 *
 * Raderna summerar ALLTID till beloppet, exakt (ägaren får resten).
 *
 * 1. Butikens andel räknas INTE här: den kommer från avräkningens uträkning (samma som
 *    månadsavräkningen och butiksrapporten, src/server/settlements/live.ts), avrundad en
 *    gång per butik, månad och avtal. En butik vars bolag (store_owners) är satt betalas
 *    till bolaget: en rad för alla bolagets butiker. Justeringar (månadens avräkning −
 *    det som redan fördelats för månaden) är exakta skillnader. Blir en butiks rad negativ
 *    (en justering nedåt större än andelen) sätts den till 0 och resten av justeringen
 *    väntar till nästa utbetalning (komponentens belopp är det som faktiskt används).
 * 2. Inköpet är vårt verkliga inköpspris (purchase_prices.unit_cost_ore), aldrig pris mot
 *    kund. Order utan inköpspris ger 0 och en varning (UNPRICED).
 * 3. Moms på vinsten per kalendermånad med underskott fört vidare mellan utbetalningar
 *    (vmbVat: halva öre bort från noll), eller momsen i försäljningen, eller ingen.
 * 4–5. Avtalet med partnern kan ändras mitt i perioden: dagarna delas i avsnitt med var sitt
 *    avtal (även "inget avtal", andel 0). Vinsten fördelas på avsnitten efter deras väntade
 *    vinst (största-restmetoden) och varje avsnitt får sin andel, avkortad mot noll som
 *    allocateToOwners (owners.ts). Ägaren får öret som blir över.
 * 7. Vid förlust bär partnern sin andel av förlusten. Partnerns rad blir aldrig negativ: det
 *    som saknas förs som skuld till nästa utbetalning (partnerCarryOutOre). En negativ rad för
 *    ägaren betyder "du behöver lägga till X kr" (NEGATIVE_OWNER).
 */

import {
  allocateLargestRemainder,
  assertBp,
  assertSafeInteger,
  BP_SCALE,
  fromBigInt,
} from "./money";
import type { IsoDate, IsoMonth } from "./types";
import { vatReserve, type VatReserveMode } from "./vat-reserve";

export const PAYOUT_RULE_VERSION = 1;

export type PayeeKind = "store_owner" | "store";
export type ShareSource = "settlement" | "live" | "none" | "trueup";

export interface Payee {
  readonly kind: PayeeKind;
  readonly id: string;
}

/** Försäljningen för en butik och kalendermånad inom utbetalningens dagar. */
export interface SplitSlice {
  /** null = försäljning i en automat som inte stod i någon butik. */
  readonly storeId: string | null;
  readonly payee: Payee | null;
  readonly month: IsoMonth;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly orders: number;
  readonly grossOre: number;
  readonly refundsOre: number;
  /** Vårt inköp för de sålda packen (order med pris). */
  readonly costOre: number;
  readonly unpricedOrders: number;
  /** Butikens andel för dagarna (avräkningens uträkning), 0 utan butik. */
  readonly storeShareOre: number;
  readonly shareSource: Exclude<ShareSource, "trueup">;
  readonly hasAgreement: boolean;
}

/** Skillnad mot en månadsavräkning som läggs på den här utbetalningen. */
export interface SplitTrueUp {
  readonly storeId: string;
  readonly payee: Payee;
  readonly month: IsoMonth;
  readonly deltaOre: number;
}

/** Dagar med samma avtal med partnern (agreementId null = inget avtal). */
export interface PartnerSegment {
  readonly agreementId: string | null;
  readonly reimburse: boolean;
  readonly bp: number;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly costOre: number;
  readonly packs: number;
  /** Väntad vinst i avsnittet (försäljning − återbetalningar − inköp − andelar), vikt. */
  readonly weightOre: number;
}

export interface SplitInput {
  readonly amountOre: number;
  readonly slices: readonly SplitSlice[];
  readonly trueUps: readonly SplitTrueUp[];
  readonly vat: {
    readonly mode: VatReserveMode;
    readonly carryInOre: number;
    readonly vatRateBp: number;
  };
  /** Avsnitten med partnerns avtal, eller null när organisationen inte har något avtal. */
  readonly partner: {
    readonly segments: readonly PartnerSegment[];
    /** Partnerns skuld från förra utbetalningen (≤ 0). */
    readonly carryInOre: number;
  } | null;
  /** Väntat från Nayax för dagarna (försäljning − återbetalningar − beräknad avgift). */
  readonly expectedNetOre: number;
}

export type SplitWarning =
  | { readonly code: "UNPRICED"; readonly orders: number }
  | { readonly code: "NO_AGREEMENT"; readonly storeId: string; readonly grossOre: number }
  | {
      readonly code: "DIFF_EXPECTED";
      readonly diffOre: number;
      readonly expectedNetOre: number;
    }
  | { readonly code: "NEGATIVE_OWNER"; readonly ore: number }
  | { readonly code: "NO_PARTNER_AGREEMENT" }
  | { readonly code: "LIVE_ESTIMATE"; readonly months: readonly IsoMonth[] }
  | { readonly code: "PARTNER_CARRY"; readonly ore: number }
  | { readonly code: "SHARE_HELD"; readonly payeeId: string; readonly ore: number }
  | { readonly code: "GAP_DAYS"; readonly from: IsoDate; readonly to: IsoDate }
  | {
      readonly code: "SHARE_JUMP";
      readonly storeId: string;
      readonly ratioBp: number;
      readonly medianBp: number;
    }
  | { readonly code: "UNMAPPED_DEVICE"; readonly serial: string };

export type SplitWarningCode = SplitWarning["code"];

/** En butik och månad på en butiksrad ("Varför?"). */
export interface StoreComponent {
  readonly storeId: string;
  readonly month: IsoMonth;
  readonly from: IsoDate | null;
  readonly to: IsoDate | null;
  readonly orders: number;
  readonly grossOre: number;
  readonly refundsOre: number;
  /** Det som används på raden. */
  readonly shareOre: number;
  /** Det uträkningen gav (skiljer sig från shareOre bara när raden hölls på 0). */
  readonly wantedOre: number;
  readonly source: ShareSource;
}

export interface PartnerComponents {
  readonly reimbOre: number;
  readonly profitShareOre: number;
  readonly carryInOre: number;
  readonly carryOutOre: number;
  readonly packs: number;
  readonly segments: readonly {
    readonly agreementId: string | null;
    readonly bp: number;
    readonly from: IsoDate;
    readonly to: IsoDate;
    readonly profitOre: number;
    readonly shareOre: number;
    readonly reimbOre: number;
  }[];
}

export interface VatComponents {
  readonly mode: VatReserveMode;
  readonly carryInOre: number;
  readonly carryOutOre: number;
  readonly months: readonly {
    readonly month: string;
    readonly marginOre: number;
    readonly vatOre: number;
  }[];
}

export type SplitLine =
  | {
      readonly kind: PayeeKind;
      readonly payeeId: string;
      readonly amountOre: number;
      readonly stores: readonly StoreComponent[];
    }
  | {
      readonly kind: "partner";
      readonly agreementId: string | null;
      readonly amountOre: number;
      readonly partner: PartnerComponents;
    }
  | { readonly kind: "vat_reserve"; readonly amountOre: number; readonly vat: VatComponents }
  | {
      readonly kind: "owner";
      readonly amountOre: number;
      readonly profitOre: number;
      readonly partnerShareOre: number;
    };

export interface SplitTotals {
  readonly amountOre: number;
  readonly storesOre: number;
  readonly partnerReimbOre: number;
  readonly partnerProfitOre: number;
  readonly partnerOre: number;
  readonly partnerCarryInOre: number;
  readonly partnerCarryOutOre: number;
  readonly vatOre: number;
  readonly vatCarryInOre: number;
  readonly vatCarryOutOre: number;
  readonly ownerOre: number;
  readonly profitOre: number;
  readonly grossOre: number;
  readonly refundsOre: number;
  readonly costOre: number;
  readonly orders: number;
  readonly expectedNetOre: number;
  /** Belopp − väntat. */
  readonly diffOre: number;
}

export interface SplitResult {
  readonly lines: readonly SplitLine[];
  readonly totals: SplitTotals;
  readonly warnings: readonly SplitWarning[];
}

function check(value: number, label: string): void {
  assertSafeInteger(value, label);
}

/** profit × bp / 10 000 avkortat mot noll (samma som allocateToOwners). */
export function shareTruncated(profitOre: number, bp: number): number {
  assertSafeInteger(profitOre, "Vinsten");
  assertBp(bp, "Andelen");
  const v = fromBigInt((BigInt(profitOre) * BigInt(bp)) / BigInt(BP_SCALE));
  return v === 0 ? 0 : v;
}

/** Sant när utbetalningen skiljer mer än max(5 kr, 1 %) mot det vi väntade. */
export function diffMatters(diffOre: number, expectedNetOre: number): boolean {
  return Math.abs(diffOre) > Math.max(500, Math.floor(Math.abs(expectedNetOre) / 100));
}

/** Delningen av en utbetalning (se filhuvudet). */
export function splitPayout(input: SplitInput): SplitResult {
  check(input.amountOre, "Beloppet");
  check(input.expectedNetOre, "Väntat belopp");
  const warnings: SplitWarning[] = [];

  // 1. Butikerna, en rad per betalningsmottagare.
  const payees = new Map<string, { payee: Payee; comps: StoreComponent[] }>();
  const payeeOf = (p: Payee) => {
    const key = `${p.kind}:${p.id}`;
    let entry = payees.get(key);
    if (!entry) {
      entry = { payee: p, comps: [] };
      payees.set(key, entry);
    }
    return entry;
  };
  let grossOre = 0;
  let refundsOre = 0;
  let costOre = 0;
  let orders = 0;
  let unpriced = 0;
  const liveMonths = new Set<IsoMonth>();
  const vatMonths = new Map<string, { grossOre: number; refundsOre: number; costOre: number }>();
  for (const s of input.slices) {
    for (const [v, l] of [
      [s.grossOre, "Försäljningen"],
      [s.refundsOre, "Återbetalningarna"],
      [s.costOre, "Inköpet"],
      [s.storeShareOre, "Butikens andel"],
    ] as const) {
      check(v, l);
    }
    grossOre += s.grossOre;
    refundsOre += s.refundsOre;
    costOre += s.costOre;
    orders += s.orders;
    unpriced += s.unpricedOrders;
    const vm = vatMonths.get(s.month) ?? { grossOre: 0, refundsOre: 0, costOre: 0 };
    vatMonths.set(s.month, {
      grossOre: vm.grossOre + s.grossOre,
      refundsOre: vm.refundsOre + s.refundsOre,
      costOre: vm.costOre + s.costOre,
    });
    if (s.storeId !== null && s.grossOre > 0 && !s.hasAgreement) {
      warnings.push({ code: "NO_AGREEMENT", storeId: s.storeId, grossOre: s.grossOre });
    }
    if (s.shareSource === "live" && s.storeId !== null) liveMonths.add(s.month);
    if (s.storeId === null || s.payee === null) continue;
    payeeOf(s.payee).comps.push({
      storeId: s.storeId,
      month: s.month,
      from: s.from,
      to: s.to,
      orders: s.orders,
      grossOre: s.grossOre,
      refundsOre: s.refundsOre,
      shareOre: s.storeShareOre,
      wantedOre: s.storeShareOre,
      source: s.shareSource,
    });
  }
  for (const t of input.trueUps) {
    check(t.deltaOre, "Justeringen");
    if (t.deltaOre === 0) continue;
    payeeOf(t.payee).comps.push({
      storeId: t.storeId,
      month: t.month,
      from: null,
      to: null,
      orders: 0,
      grossOre: 0,
      refundsOre: 0,
      shareOre: t.deltaOre,
      wantedOre: t.deltaOre,
      source: "trueup",
    });
  }
  const storeLines: Extract<SplitLine, { kind: PayeeKind }>[] = [];
  for (const { payee, comps } of payees.values()) {
    let raw = comps.reduce((a, c) => a + c.shareOre, 0);
    let held = 0;
    if (raw < 0) {
      // Negativa delar minskas (nyaste först) tills raden är 0; resten väntar.
      let deficit = -raw;
      for (let i = comps.length - 1; i >= 0 && deficit > 0; i--) {
        const c = comps[i]!;
        if (c.shareOre >= 0) continue;
        const take = Math.min(deficit, -c.shareOre);
        comps[i] = { ...c, shareOre: c.shareOre + take };
        deficit -= take;
        held += take;
      }
      raw = 0;
    }
    if (held > 0) warnings.push({ code: "SHARE_HELD", payeeId: payee.id, ore: held });
    comps.sort((a, b) =>
      a.month !== b.month ? (a.month < b.month ? -1 : 1) : a.storeId < b.storeId ? -1 : 1,
    );
    storeLines.push({ kind: payee.kind, payeeId: payee.id, amountOre: raw, stores: comps });
  }
  storeLines.sort((a, b) =>
    b.amountOre !== a.amountOre ? b.amountOre - a.amountOre : a.payeeId < b.payeeId ? -1 : 1,
  );
  const storesOre = storeLines.reduce((a, l) => a + l.amountOre, 0);

  // 3. Momsen att spara.
  const vat = vatReserve(
    input.vat.mode,
    [...vatMonths.entries()].map(([month, v]) => ({ month, ...v })),
    input.vat.carryInOre,
    input.vat.vatRateBp,
  );

  // 2. Inköpet tillbaka till partnern, och 4–5 vinsten och partnerns del.
  const segments = input.partner?.segments ?? [];
  let reimbOre = 0;
  let packs = 0;
  for (const seg of segments) {
    assertBp(seg.bp, "Partnerns andel");
    check(seg.costOre, "Inköpet");
    if (seg.reimburse && seg.agreementId !== null) {
      reimbOre += seg.costOre;
      packs += seg.packs;
    }
  }
  const profitOre = input.amountOre - storesOre - reimbOre - vat.reserveOre;
  const weights = segments.map((s) => Math.max(0, s.weightOre));
  const parts =
    segments.length === 0
      ? []
      : allocateLargestRemainder(
          profitOre,
          weights.some((w) => w > 0) ? weights : segments.map(() => 1),
        );
  let profitShareOre = 0;
  const segOut = segments.map((seg, i) => {
    const part = parts[i]!;
    const share = seg.agreementId === null ? 0 : shareTruncated(part, seg.bp);
    profitShareOre += share;
    return {
      agreementId: seg.agreementId,
      bp: seg.bp,
      from: seg.from,
      to: seg.to,
      profitOre: part,
      shareOre: share,
      reimbOre: seg.reimburse && seg.agreementId !== null ? seg.costOre : 0,
    };
  });
  const hasPartner = segments.some((s) => s.agreementId !== null);
  const carryIn = hasPartner ? Math.min(0, input.partner?.carryInOre ?? 0) : 0;
  const partnerRaw = reimbOre + profitShareOre + carryIn;
  const partnerOre = hasPartner ? Math.max(0, partnerRaw) : 0;
  const partnerCarryOut = hasPartner && partnerRaw < 0 ? partnerRaw : 0;
  if (partnerCarryOut < 0) warnings.push({ code: "PARTNER_CARRY", ore: partnerCarryOut });
  if (!hasPartner) warnings.push({ code: "NO_PARTNER_AGREEMENT" });

  // 6. Ägaren får resten.
  const ownerOre = input.amountOre - storesOre - partnerOre - vat.reserveOre;
  if (ownerOre < 0) warnings.push({ code: "NEGATIVE_OWNER", ore: ownerOre });
  if (unpriced > 0) warnings.push({ code: "UNPRICED", orders: unpriced });
  if (liveMonths.size > 0) warnings.push({ code: "LIVE_ESTIMATE", months: [...liveMonths].sort() });
  const diffOre = input.amountOre - input.expectedNetOre;
  if (diffMatters(diffOre, input.expectedNetOre)) {
    warnings.push({ code: "DIFF_EXPECTED", diffOre, expectedNetOre: input.expectedNetOre });
  }

  const lines: SplitLine[] = [...storeLines];
  if (hasPartner) {
    const agreementId =
      [...segments].reverse().find((s) => s.agreementId !== null)?.agreementId ?? null;
    lines.push({
      kind: "partner",
      agreementId,
      amountOre: partnerOre,
      partner: {
        reimbOre,
        profitShareOre,
        carryInOre: carryIn,
        carryOutOre: partnerCarryOut,
        packs,
        segments: segOut,
      },
    });
  }
  lines.push({
    kind: "vat_reserve",
    amountOre: vat.reserveOre,
    vat: {
      mode: input.vat.mode,
      carryInOre: input.vat.mode === "vmb" ? Math.max(0, input.vat.carryInOre) : 0,
      carryOutOre: vat.carryOutOre,
      months: vat.months,
    },
  });
  lines.push({
    kind: "owner",
    amountOre: ownerOre,
    profitOre,
    partnerShareOre: hasPartner ? profitShareOre : 0,
  });

  const sum = lines.reduce((a, l) => a + l.amountOre, 0);
  if (sum !== input.amountOre) {
    // Kan inte hända (ägaren får resten); skydd mot framtida ändringar.
    throw new RangeError(`Raderna blir ${sum} öre, inte ${input.amountOre}.`);
  }

  return {
    lines,
    totals: {
      amountOre: input.amountOre,
      storesOre,
      partnerReimbOre: hasPartner ? reimbOre : 0,
      partnerProfitOre: hasPartner ? profitShareOre : 0,
      partnerOre,
      partnerCarryInOre: carryIn,
      partnerCarryOutOre: partnerCarryOut,
      vatOre: vat.reserveOre,
      vatCarryInOre: input.vat.mode === "vmb" ? Math.max(0, input.vat.carryInOre) : 0,
      vatCarryOutOre: vat.carryOutOre,
      ownerOre,
      profitOre,
      grossOre,
      refundsOre,
      costOre,
      orders,
      expectedNetOre: input.expectedNetOre,
      diffOre,
    },
    warnings,
  };
}
