/**
 * Texterna på Utbetalningar (rena funktioner, testade i model.test.ts): varningarna med en
 * åtgärd var, raderna i "Varför?" och betyget på kortet. Enkel svenska, inga facktermer
 * (inte "allokering", "VMB" eller "bp").
 */

import { coverageRangeText, type SplitTotals, type SplitWarning } from "@/domain";

import { kr, krExact, monthName } from "../../_components/fmt";

export interface WarningView {
  readonly key: string;
  readonly tone: "warning" | "critical" | "info";
  readonly text: string;
  readonly action: { readonly label: string; readonly href: string } | null;
}

const pctText = (bp: number) => `${Math.round(bp / 100)} %`;

/** En varning som text och en åtgärd. `storeName` ger butikens namn. */
export function warningView(
  w: SplitWarning,
  storeName: (id: string) => string,
  payoutHref: string | null,
): WarningView | null {
  switch (w.code) {
    case "UNPRICED":
      return {
        key: "unpriced",
        tone: "warning",
        text: `${w.orders} sålda paket saknar inköpspris. Partnern får inget tillbaka för dem förrän priset finns.`,
        action: { label: "Lägg in pris", href: "/inkopspriser" },
      };
    case "NO_AGREEMENT":
      return {
        key: `noag:${w.storeId}`,
        tone: "warning",
        text: `${storeName(w.storeId)} har inget avtal, så butiken får 0 kr.`,
        action: { label: "Lägg till avtal", href: "/butiker" },
      };
    case "DIFF_EXPECTED":
      return {
        key: "diff",
        tone: "info",
        text:
          w.diffOre < 0
            ? `Nayax betalade ${kr(-w.diffOre)} mindre än vi väntade.`
            : `Nayax betalade ${kr(w.diffOre)} mer än vi väntade.`,
        action: payoutHref ? { label: "Visa", href: payoutHref } : null,
      };
    case "NEGATIVE_OWNER":
      return {
        key: "neg",
        tone: "critical",
        text: `Pengarna räcker inte. Du behöver lägga till ${krExact(-w.ore)}.`,
        action: payoutHref ? { label: "Visa", href: payoutHref } : null,
      };
    case "NO_PARTNER_AGREEMENT":
      return {
        key: "nopartner",
        tone: "info",
        text: "Inget partneravtal finns, så hela vinsten räknas som din.",
        action: { label: "Lägg till partner", href: "/installningar#partneravtal" },
      };
    case "LIVE_ESTIMATE":
      return null;
    case "PARTNER_CARRY":
      return {
        key: "carry",
        tone: "info",
        text: `Partnerns del av förlusten (${krExact(-w.ore)}) dras från nästa utbetalning.`,
        action: null,
      };
    case "SHARE_HELD":
      return {
        key: `held:${w.payeeId}`,
        tone: "info",
        text: `En butik har fått ${krExact(w.ore)} för mycket tidigare. Det dras från nästa utbetalning.`,
        action: null,
      };
    case "GAP_DAYS":
      return {
        key: `gap:${w.from}`,
        tone: "warning",
        text: `${coverageRangeText(w.from, w.to)} saknas i utbetalningarna.`,
        action: { label: "Lägg in", href: "/pengar/utbetalningar?lagg-in=1" },
      };
    case "SHARE_JUMP":
      return {
        key: `jump:${w.storeId}`,
        tone: "warning",
        text: `${storeName(w.storeId)} får ${pctText(w.ratioBp)} av försäljningen, mot vanligtvis ${pctText(w.medianBp)}.`,
        action: { label: "Visa avtalet", href: "/butiker" },
      };
    case "SHARE_UNKNOWN":
      return {
        key: `unknown:${w.storeId}`,
        tone: "critical",
        text: `${storeName(w.storeId)}s andel går inte att räkna än (${w.message.replace(/\.$/, "")}). Rätta det först, sedan kan du betala.`,
        action: { label: "Lägg in pris", href: "/inkopspriser" },
      };
    case "STORE_OVERPAID":
      return {
        key: `over:${w.storeId}:${w.month}`,
        tone: "warning",
        text: `${storeName(w.storeId)} fick ${krExact(w.ore)} för mycket för ${monthName(w.month)}. Lägg skillnaden på nästa avräkning så dras den av.`,
        action: { label: "Öppna Butiker", href: "/butiker" },
      };
    case "LOCKED_ADJUST": {
      const parts = [
        w.partnerOre !== 0
          ? `partnern ${w.partnerOre > 0 ? "+" : "−"}${krExact(Math.abs(w.partnerOre))}`
          : null,
        w.vatOre !== 0 ? `momsen ${w.vatOre > 0 ? "+" : "−"}${krExact(Math.abs(w.vatOre))}` : null,
      ].filter(Boolean);
      return {
        key: "lockedadj",
        tone: "info",
        text: `Ett inköpspris eller momsen ändrades efter en tidigare betalning. Rättat här: ${parts.join(", ")}.`,
        action: null,
      };
    }
    case "UNMAPPED_DEVICE":
      return {
        key: `dev:${w.serial}`,
        tone: "warning",
        text: `Automaten ${w.serial} i rapporten finns inte hos oss.`,
        action: { label: "Visa automaterna", href: "/automater" },
      };
  }
}

/** Varningarna utan dubbletter, viktigast först. */
export function warningViews(
  warnings: readonly SplitWarning[],
  storeName: (id: string) => string,
  payoutHref: string | null,
): WarningView[] {
  const order = { critical: 0, warning: 1, info: 2 } as const;
  const seen = new Set<string>();
  const out: WarningView[] = [];
  for (const w of warnings) {
    const v = warningView(w, storeName, payoutHref);
    if (!v || seen.has(v.key)) continue;
    seen.add(v.key);
    out.push(v);
  }
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

/** "Justering oktober +3 kr", "3–9 nov.: 52 000 kr försäljning". */
export function storeComponentText(c: {
  readonly month: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly grossOre: number;
  readonly refundsOre: number;
  readonly orders: number;
  readonly shareOre: number;
  readonly wantedOre: number;
  readonly source: string;
}): { label: string; detail: string; amount: string } {
  if (c.source === "trueup") {
    const sign = c.shareOre >= 0 ? "+" : "−";
    return {
      label: `Justering ${monthName(c.month)}`,
      detail: "Skillnad mot butikens avräkning för hela månaden.",
      amount: `${sign}${krExact(Math.abs(c.shareOre))}`,
    };
  }
  const days = c.from && c.to ? coverageRangeText(c.from, c.to) : monthName(c.month);
  const parts = [`${kr(c.grossOre)} försäljning`, `${c.orders} köp`];
  if (c.refundsOre > 0) parts.push(`${kr(c.refundsOre)} återbetalt`);
  return {
    label: days,
    detail:
      parts.join(", ") +
      (c.source === "settlement"
        ? ". Andelen enligt månadens avräkning."
        : c.source === "live"
          ? ". Andelen enligt avtalet."
          : ". Andelen kunde inte räknas än."),
    amount: krExact(c.shareOre),
  };
}

/** Badge på kortet: "Allt utbetalt", "Allt utbetalt · 161 kr kvar till dig" eller "2 kvar". */
export function payoutBadge(
  unpaidLines: number,
  hasAllocation: boolean,
  ownerLeftOre = 0,
): {
  readonly text: string;
  readonly tone: "success" | "warning" | "neutral";
} {
  if (!hasAllocation) return { text: "Räknas inte", tone: "neutral" };
  if (unpaidLines === 0) {
    return {
      text:
        ownerLeftOre > 0 ? `Allt utbetalt · ${kr(ownerLeftOre)} kvar till dig` : "Allt utbetalt",
      tone: "success",
    };
  }
  return { text: `${unpaidLines} kvar`, tone: "warning" };
}

/** Kronor från fältet ("1 234,50") till öre, eller null. Tillåter 0 när `allowZero`. */
export function parseKr(text: string, allowZero = false): number | null {
  const t = text
    .replace(/kr/gi, "")
    .replace(/[\s  ]/g, "")
    .replace(/^−/, "-")
    .replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  const negative = t.startsWith("-");
  const [whole, frac = ""] = t.replace("-", "").split(".");
  const ore = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(ore)) return null;
  if (ore === 0 && !allowZero) return null;
  return negative ? -ore : ore;
}

/** Öre som text i ett fält ("1234,50"). */
export function oreToField(ore: number | null | undefined): string {
  if (ore === null || ore === undefined) return "";
  const abs = Math.abs(ore);
  const s = `${Math.floor(abs / 100)}${abs % 100 ? `,${String(abs % 100).padStart(2, "0")}` : ""}`;
  return ore < 0 ? `-${s}` : s;
}

/**
 * "Nayax 1–15 okt, 16–31 okt": högst två perioder utskrivna, fler som "första … sista (N
 * perioder)", så att raden inte blir tre eller fyra rader lång på telefonen.
 */
export function periodsText(texts: readonly string[]): string {
  const list = [...new Set(texts)];
  if (list.length <= 2) return `Nayax ${list.join(", ")}`;
  return `Nayax ${list[0]} … ${list[list.length - 1]} (${list.length} perioder)`;
}

/** En rad i "Så räknade vi". `info`: står för sig ("varav"), räknas inte bort ovanför. */
export interface CountedRow {
  readonly label: string;
  readonly ore: number;
  readonly info?: boolean;
}

/**
 * Raderna i "Så räknade vi" för en utbetalning. Med partner: inköpet går tillbaka till
 * partnern och det som blir kvar är vinsten att dela. Utan partner dras inköpet inte här
 * (du har redan betalat packen), så det som blir kvar är inte vinst: "Kvar till dig, inköpet
 * ingår", och inköpet står under som "varav".
 */
export function countedRows(
  t: Pick<
    SplitTotals,
    | "grossOre"
    | "refundsOre"
    | "expectedNetOre"
    | "amountOre"
    | "storesOre"
    | "partnerReimbOre"
    | "vatOre"
    | "refundsOutsideOre"
    | "profitOre"
    | "partnerAdjustOre"
    | "costOre"
  >,
  hasPartner: boolean,
): CountedRow[] {
  // En återbetalning av inköpet till partnern betyder partner, även om raden saknas.
  const partner = hasPartner || t.partnerReimbOre !== 0;
  const rows: CountedRow[] = [
    { label: "Försäljning", ore: t.grossOre },
    { label: "Återbetalt till kunder", ore: -t.refundsOre },
    { label: "Väntat från Nayax efter avgift", ore: t.expectedNetOre },
    { label: "Pengar in", ore: t.amountOre },
    { label: "Till butikerna", ore: -t.storesOre },
  ];
  if (partner) rows.push({ label: "Inköpet tillbaka till partnern", ore: -t.partnerReimbOre });
  rows.push({ label: "Moms att spara", ore: -t.vatOre });
  if (t.refundsOutsideOre) {
    rows.push({ label: "Återbetalningar du gjort själv", ore: -t.refundsOutsideOre });
  }
  if (partner) {
    rows.push({ label: "Vinst att dela", ore: t.profitOre });
  } else {
    rows.push({ label: "Kvar till dig, inköpet ingår", ore: t.profitOre });
    if (typeof t.costOre === "number" && t.costOre > 0) {
      rows.push({ label: "Varav inköpet av packen", ore: t.costOre, info: true });
    }
  }
  if (t.partnerAdjustOre) {
    rows.push({ label: "Rättelse till partnern från tidigare", ore: -t.partnerAdjustOre });
  }
  return rows;
}
