/**
 * Pengar → "Vem pengarna är till" (G4): försäljningen i perioden delad på ägaren, partnern,
 * butikerna (en rad per bolag, annars per butik), momsen att spara, kortavgiften och
 * återbetalningarna. Ren funktion, belopp i öre.
 *
 * Inget räknas på ett nytt sätt: perioden delas EXAKT som en utbetalning från Nayax som
 * täcker periodens dagar (splitPayout, src/domain/payout-split.ts), med beloppet vi väntar
 * från Nayax (försäljning − kortavgift, − återbetalningar när de görs i Nayax). Butikernas
 * andel kommer från avräkningens uträkning (src/server/settlements/live.ts) eller den
 * sparade månadsavräkningen, partnern från avtalet (inköpet tillbaka + andel av vinsten),
 * momsen från vat-reserve.ts. Underlaget byggs av loadAllocationInputsTx (src/server/
 * payouts/inputs.ts) utan tidigare utbetalningar (inga skulder eller rättelser förs in).
 *
 * Grunden är försäljningen inkl. moms (allt kunderna betalat, testköp räknas inte):
 *
 *   försäljning = Min andel + partner + Σ butiker + moms + kortavgift + återbetalningar
 *
 * exakt i öre. Kortavgiften och (vid återbetalningar i Nayax) återbetalningarna drar Nayax
 * innan pengarna kommer. Betalar ägaren återbetalningarna själv dras de från ägarens rad
 * (de är redan dragna från vinsten före partnerns andel, regel 9 i payout-split.ts).
 *
 * Visning i hela kronor: raderna avrundas kumulativt i visningsordning (rad i =
 * round(Σ t.o.m. i) − round(Σ t.o.m. i−1)), så att kronorna på raderna summerar till
 * försäljningen i kronor och varje rad skiljer högst 1 kr från sin egen avrundning.
 */

import {
  ratioBp,
  splitPayout,
  type SplitInput,
  type SplitLine,
  type SplitWarning,
  type VatReserveMode,
} from "@/domain";

export type SplitRowKind =
  "owner" | "partner" | "store_owner" | "store" | "vat" | "fees" | "refunds";

export interface SplitRowStore {
  readonly storeId: string;
  readonly name: string;
  readonly amountOre: number;
}

export interface SplitRow {
  readonly key: string;
  readonly kind: SplitRowKind;
  readonly label: string;
  /** Exakt belopp (öre). Bara ägarens rad kan vara negativ. */
  readonly amountOre: number;
  /** Beloppet i hela kronor (som öre, jämnt hundratal), summerar till grunden. */
  readonly displayOre: number;
  /** Andel av försäljningen (bp, absolut), null utan försäljning. */
  readonly shareBp: number | null;
  /** Bolagets butiker (bara store_owner), störst först. */
  readonly stores?: readonly SplitRowStore[];
  /** Partnern: inköpet tillbaka, andelen av vinsten och avtalets andel (bp). */
  readonly partner?: {
    readonly hasAgreement: boolean;
    readonly reimbOre: number;
    readonly profitShareOre: number;
    readonly bp: number | null;
    /** Partnerns del av en förlust (≤ 0) som inte dras här. */
    readonly lossOre: number;
  };
  /** Momsläget (bara vat). */
  readonly vatMode?: VatReserveMode;
  /** Återbetalningar görs i Nayax eller av ägaren själv (bara refunds). */
  readonly refundsVia?: "nayax" | "outside";
}

export interface SplitView {
  /** Försäljningen inkl. moms (öre), raderna summerar exakt till den. */
  readonly basisOre: number;
  /** Försäljningen i hela kronor (öre), raderna i kronor summerar till den. */
  readonly basisDisplayOre: number;
  /** "Min andel" först, sedan störst först. */
  readonly rows: readonly SplitRow[];
  readonly orders: number;
  /** Ingen försäljning och inga återbetalningar i perioden. */
  readonly empty: boolean;
  /** Vinsten efter butiker, partnerns inköp och moms (före partnerns andel). */
  readonly profitOre: number;
  /** Order utan inköpspris (UNPRICED): partnerns inköp och momsen blir för låga. */
  readonly unpricedOrders: number;
  /** Butiker vars andel inte gick att räkna (SHARE_UNKNOWN), räknas som 0 här. */
  readonly shareUnknownStoreIds: readonly string[];
  /** Månader där butikens andel är räknad nu (ingen sparad avräkning). */
  readonly liveMonths: readonly string[];
}

export interface SplitViewInput {
  /** Underlaget (loadAllocationInputsTx); `amountOre` och `expectedNetOre` sätts här. */
  readonly split: SplitInput;
  /** Kortavgiften för perioden (samma uppskattning som det vi väntar från Nayax). */
  readonly feesOre: number;
  readonly refundsVia: "nayax" | "outside";
  readonly extraWarnings?: readonly SplitWarning[];
  readonly storeName: (storeId: string) => string;
  readonly ownerName: (ownerId: string) => string;
  /** Partnerns namn i avtalet, eller null utan avtal. */
  readonly partnerName: string | null;
}

/** Fördelningen för perioden (se filhuvudet). */
export function splitView(input: SplitViewInput): SplitView {
  const slices = input.split.slices;
  const grossOre = slices.reduce((a, s) => a + s.grossOre, 0);
  const refundsOre = slices.reduce((a, s) => a + s.refundsOre, 0);
  const orders = slices.reduce((a, s) => a + s.orders, 0);
  const inNayax = input.refundsVia === "nayax";
  const amountOre = grossOre - input.feesOre - (inNayax ? refundsOre : 0);
  const result = splitPayout({
    ...input.split,
    amountOre,
    expectedNetOre: amountOre,
    refundsOutsideOre: inNayax ? 0 : refundsOre,
  });
  const refundsOutside = inNayax ? 0 : refundsOre;

  const raw: Omit<SplitRow, "displayOre" | "shareBp">[] = [];
  let partnerLine: Extract<SplitLine, { kind: "partner" }> | null = null;
  for (const line of result.lines) {
    if (line.kind === "store" || line.kind === "store_owner") {
      if (line.amountOre === 0) continue;
      const per = new Map<string, number>();
      for (const c of line.stores) per.set(c.storeId, (per.get(c.storeId) ?? 0) + c.shareOre);
      const stores = [...per.entries()]
        .map(([storeId, ore]) => ({ storeId, name: input.storeName(storeId), amountOre: ore }))
        .sort((a, b) => b.amountOre - a.amountOre || a.name.localeCompare(b.name, "sv"));
      raw.push({
        key: `${line.kind}:${line.payeeId}`,
        kind: line.kind,
        label:
          line.kind === "store_owner"
            ? input.ownerName(line.payeeId)
            : input.storeName(line.payeeId),
        amountOre: line.amountOre,
        ...(line.kind === "store_owner" ? { stores } : {}),
      });
    } else if (line.kind === "partner") {
      partnerLine = line;
    } else if (line.kind === "vat_reserve") {
      if (line.amountOre !== 0) {
        raw.push({
          key: "vat",
          kind: "vat",
          label: "Moms att spara",
          amountOre: line.amountOre,
          vatMode: line.vat.mode,
        });
      }
    }
  }
  const agreementBp = (() => {
    if (!partnerLine) return null;
    const seg = [...partnerLine.partner.segments].reverse().find((s) => s.agreementId !== null);
    return seg ? seg.bp : null;
  })();
  raw.push({
    key: "partner",
    kind: "partner",
    label: input.partnerName ?? "Partner",
    amountOre: partnerLine?.amountOre ?? 0,
    partner: {
      hasAgreement: partnerLine !== null,
      reimbOre: partnerLine?.partner.reimbOre ?? 0,
      profitShareOre: partnerLine?.partner.profitShareOre ?? 0,
      bp: agreementBp,
      lossOre: partnerLine?.partner.carryOutOre ?? 0,
    },
  });
  if (input.feesOre !== 0) {
    raw.push({ key: "fees", kind: "fees", label: "Kortavgift", amountOre: input.feesOre });
  }
  if (refundsOre !== 0) {
    raw.push({
      key: "refunds",
      kind: "refunds",
      label: "Återbetalningar",
      amountOre: refundsOre,
      refundsVia: input.refundsVia,
    });
  }
  const ownerLine = result.lines.find((l) => l.kind === "owner");
  const owner: Omit<SplitRow, "displayOre" | "shareBp"> = {
    key: "owner",
    kind: "owner",
    label: "Min andel",
    amountOre: (ownerLine?.amountOre ?? 0) - refundsOutside,
  };
  const others = raw.sort(
    (a, b) => b.amountOre - a.amountOre || a.label.localeCompare(b.label, "sv"),
  );
  const ordered = [owner, ...others];

  const sum = ordered.reduce((a, r) => a + r.amountOre, 0);
  if (sum !== grossOre) {
    // Kan inte hända (ägaren får resten); skydd mot framtida ändringar.
    throw new RangeError(`Fördelningen blir ${sum} öre, inte ${grossOre}.`);
  }
  const kr = (ore: number) => Math.round(ore / 100) * 100;
  let cum = 0;
  let shown = 0;
  const rows: SplitRow[] = ordered.map((r) => {
    cum += r.amountOre;
    const next = kr(cum);
    const displayOre = next - shown;
    shown = next;
    return {
      ...r,
      displayOre: displayOre === 0 ? 0 : displayOre,
      shareBp: grossOre > 0 ? ratioBp(Math.abs(r.amountOre), grossOre) : null,
    };
  });

  const warnings = [...result.warnings, ...(input.extraWarnings ?? [])];
  const unpriced = warnings.find((w) => w.code === "UNPRICED");
  const live = warnings.find((w) => w.code === "LIVE_ESTIMATE");
  return {
    basisOre: grossOre,
    basisDisplayOre: kr(grossOre),
    rows,
    orders,
    empty: grossOre === 0 && refundsOre === 0,
    profitOre: result.totals.profitOre,
    unpricedOrders: unpriced && unpriced.code === "UNPRICED" ? unpriced.orders : 0,
    shareUnknownStoreIds: [
      ...new Set(warnings.flatMap((w) => (w.code === "SHARE_UNKNOWN" ? [w.storeId] : []))),
    ],
    liveMonths: live && live.code === "LIVE_ESTIMATE" ? live.months : [],
  };
}
