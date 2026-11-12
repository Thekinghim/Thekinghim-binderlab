/**
 * Verifikaten som skickas till Fortnox, byggda på samma underlag och samma kontoplan som
 * Ekonomi → Bokföring (bokföringsrapporten i @/reports och kontoplanen i
 * src/server/bokforing/plan.ts). Inget andra bokföringssystem: här bestäms bara hur det
 * befintliga underlaget delas upp i verifikat som kan skickas ett och ett, var för sig.
 *
 *   sales            en per månad, daterad månadens sista dag
 *                      D avräkning (1580)   försäljning inkl. moms − återbetalningar
 *                      K försäljning (3000) en rad per automat
 *                      D försäljning        återbetalningar till kunder
 *                    Momsen styrs av momssatsen i Inställningar:
 *                      0 %  utan VMB: som ovan
 *                      0 %  med VMB:  K försäljning VMB (3211), K VMB-moms (2616), som månadspaketet
 *                      > 0: K försäljning exkl. moms per automat, K utgående moms (2611)
 *   payout           en per utbetalning, daterad dagen pengarna kom in
 *                      D bank (1930)        utbetalt
 *                      D kortavgift (6040)  Nayax kortavgift
 *                      D bankavgift (6570)  en rad per avdrag
 *                      D övrigt (6590)      en rad per engångsavgift/justering, med Nayax text
 *                      K avräkning (1580)   summan (= försäljningen när allt stämmer)
 *   store_share      en per månad: D butikernas andel (6090), D hyra (5010), K skuld (2990)
 *   settlement_paid  en per betald avräkning: D skuld (2990), K bank (1930)
 *   cogs             en per månad: D inköpsvärde (4960), K lager (1460)      [av från början]
 *   fixed_costs      en per månad: D kostnad (6990) per kostnad, K skuld (2990) [av från början]
 *
 * Kortavgiften bokförs bara vid utbetalningen, med Nayax faktiska belopp. Försäljnings-
 * verifikatet har därför ingen uppskattad kortavgift (månadspaketets SIE-fil har det, eftersom
 * den inte har något verifikat för utbetalningen): annars skulle avgiften bokföras två gånger.
 *
 * Ett verifikat som inte kan byggas säkert byggs inte alls: det får `hold` med en kod och en
 * mening till ägaren. Rena funktioner, belopp i öre, positivt = debet.
 */

import { createHash } from "node:crypto";

import { monthEnd, vatOfGross, type IsoDate } from "@/domain";
import { monthText, type AccountantReport } from "@/reports";
import type { AccountPlan } from "@/server/bokforing/plan";

import type { FortnoxAccountKey, FortnoxMapping, FortnoxVoucherKind } from "./mapping";

export interface VoucherRow {
  readonly account: string;
  /** Positivt = debet, negativt = kredit. */
  readonly amountOre: number;
  readonly text: string;
}

/** Varför verifikatet inte skickas än. `wait` löser sig självt, övriga kräver en människa. */
export type HoldCode =
  "wait" | "missing_cost" | "unmapped_account" | "vat_conflict" | "unclear_payout";

export interface DesiredVoucher {
  readonly kind: FortnoxVoucherKind;
  /** Månad ("2026-10") eller källradens id. */
  readonly sourceRef: string;
  readonly date: IsoDate;
  readonly description: string;
  readonly rows: readonly VoucherRow[];
  readonly hold: { readonly code: HoldCode; readonly detail: string } | null;
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const clip = (t: string, max: number) => {
  const flat = t.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** Kastar om raderna inte balanserar. Rader med 0 är redan borttagna. */
export function assertBalanced(rows: readonly VoucherRow[]): void {
  let sum = 0;
  for (const r of rows) {
    if (!Number.isSafeInteger(r.amountOre)) throw new RangeError("Beloppen ska vara heltal i öre.");
    sum += r.amountOre;
  }
  if (sum !== 0) throw new RangeError(`Verifikatet balanserar inte (${sum} öre).`);
}

class Builder {
  readonly rows: VoucherRow[] = [];
  private unmapped: string | null = null;

  constructor(
    private readonly plan: AccountPlan,
    private readonly mapping: FortnoxMapping,
  ) {}

  /** Rad på ett konto ur kontoplanen (Ekonomi → Bokföring). */
  plan_(key: keyof AccountPlan, amountOre: number, text: string): void {
    if (amountOre !== 0)
      this.rows.push({ account: this.plan[key], amountOre, text: clip(text, 100) });
  }

  /** Rad på ett konto ur Fortnox-mappningen. Saknas kontot stoppas verifikatet. */
  map(key: FortnoxAccountKey, amountOre: number, text: string, use: string): void {
    if (amountOre === 0) return;
    const account = this.mapping.accounts[key];
    if (!account) {
      this.unmapped ??= use;
      return;
    }
    this.rows.push({ account, amountOre, text: clip(text, 100) });
  }

  done(
    kind: FortnoxVoucherKind,
    sourceRef: string,
    date: IsoDate,
    description: string,
    hold: DesiredVoucher["hold"] = null,
  ): DesiredVoucher | null {
    if (this.unmapped) {
      return {
        kind,
        sourceRef,
        date,
        description: clip(description, 170),
        rows: [],
        hold: {
          code: "unmapped_account",
          detail: `Välj ett konto för "${this.unmapped}" under Datakällor → Fortnox.`,
        },
      };
    }
    if (this.rows.length === 0) return null;
    assertBalanced(this.rows);
    return { kind, sourceRef, date, description: clip(description, 170), rows: this.rows, hold };
  }
}

export interface SalesInput {
  readonly month: string;
  readonly report: AccountantReport;
  /** Återbetalningar till kunder med återbetalningsdag i månaden (≥ 0). */
  readonly refundsOre: number;
  /** "VMB i bokföringen" för månaden och månadens VMB-moms (bara när momssatsen är 0). */
  readonly vmb: { readonly enabled: boolean; readonly vatOre: number };
}

/** Försäljningen för en månad. Momsen följer momssatsen i Inställningar (report.vatRateBp). */
export function salesVoucher(
  input: SalesInput,
  plan: AccountPlan,
  mapping: FortnoxMapping,
): DesiredVoucher | null {
  const { report, month } = input;
  const name = monthText(month);
  const date = monthEnd(month);
  const description = `Försäljning automater ${name}`;
  const t = report.totals;
  const rate = report.vatRateBp;
  if (rate !== 0 && input.vmb.enabled) {
    return {
      kind: "sales",
      sourceRef: month,
      date,
      description,
      rows: [],
      hold: {
        code: "vat_conflict",
        detail:
          "Momssatsen i Inställningar är inte 0 och VMB i bokföringen är på. Båda kan inte gälla samtidigt. Fråga redovisningsbyrån vilken som ska gälla.",
      },
    };
  }
  const b = new Builder(plan, mapping);
  const refunds = input.refundsOre;
  b.plan_("settlement", t.grossOre - refunds, description);
  if (rate === 0 && input.vmb.enabled) {
    // Som månadspaketet (src/server/bokforing/sie.ts): VMB räknas samlat för månaden.
    const sales = t.grossOre - refunds;
    b.plan_("sales_vmb", -(sales - input.vmb.vatOre), `Försäljning VMB ${name}`);
    b.plan_("vat_vmb", -input.vmb.vatOre, `VMB-moms ${name}`);
  } else {
    // En rad per automat när raderna summerar till månadens försäljning, annars en rad.
    const machines = report.machines.filter((m) => m.netOre !== 0);
    const netSum = machines.reduce((s, m) => s + m.netOre, 0);
    const vatSum = report.machines.reduce((s, m) => s + m.vatOre, 0);
    if (machines.length > 0 && netSum === t.netOre && vatSum === t.vatOre) {
      for (const m of machines) b.plan_("sales", -m.netOre, `Försäljning ${m.name} ${name}`);
    } else {
      b.plan_("sales", -t.netOre, `Försäljning ${name}`);
    }
    b.map("vat_out", -t.vatOre, `Utgående moms ${name}`, "Utgående moms");
    const refundVat = vatOfGross(refunds, rate);
    b.plan_("sales", refunds - refundVat, `Återbetalningar till kunder ${name}`);
    b.map("vat_out", refundVat, `Moms på återbetalningar ${name}`, "Utgående moms");
  }
  return b.done("sales", month, date, description);
}

/** Butikernas andel och hyra för en månad, som skuld till butikerna. */
export function storeShareVoucher(
  month: string,
  report: AccountantReport,
  plan: AccountPlan,
  mapping: FortnoxMapping,
): DesiredVoucher | null {
  const name = monthText(month);
  const b = new Builder(plan, mapping);
  for (const s of report.stores) {
    if (s.kind !== "store" || s.compensationOre === 0) continue;
    b.plan_("store_share", s.commissionOre, `Andel ${s.name} ${name}`);
    b.plan_("rent", s.rentOre, `Hyra ${s.name} ${name}`);
    b.plan_("store_payable", -s.compensationOre, `Att betala ${s.name} ${name}`);
  }
  const unpriced = report.profitSplitUnpricedOrders ?? 0;
  return b.done(
    "store_share",
    month,
    monthEnd(month),
    `Butikernas andel ${name}`,
    unpriced > 0
      ? {
          code: "missing_cost",
          detail: `${unpriced} order saknar inköpspris, så butikens andel för ${name} är inte klar.`,
        }
      : null,
  );
}

/** Inköpsvärdet för månadens sålda pack (bara när ägaren slagit på det). */
export function cogsVoucher(
  month: string,
  report: AccountantReport,
  plan: AccountPlan,
  mapping: FortnoxMapping,
): DesiredVoucher | null {
  const name = monthText(month);
  const t = report.totals;
  const b = new Builder(plan, mapping);
  b.map("cogs", t.costOre, `Inköpsvärde sålda pack ${name}`, "Inköpsvärde för sålda pack");
  b.map("inventory", -t.costOre, `Inköpsvärde sålda pack ${name}`, "Lager");
  return b.done(
    "cogs",
    month,
    monthEnd(month),
    `Inköpsvärde sålda pack ${name}`,
    t.unpricedOrders > 0
      ? {
          code: "missing_cost",
          detail: `${t.unpricedOrders} order saknar inköpspris, så inköpsvärdet för ${name} är inte klart.`,
        }
      : null,
  );
}

export interface FixedCostLine {
  readonly name: string;
  /** Månadens del av kostnaden, öre. */
  readonly amountOre: number;
}

/** Månadens fasta kostnader, en rad per kostnad (bara när ägaren slagit på det). */
export function fixedCostsVoucher(
  month: string,
  costs: readonly FixedCostLine[],
  plan: AccountPlan,
  mapping: FortnoxMapping,
): DesiredVoucher | null {
  const name = monthText(month);
  const b = new Builder(plan, mapping);
  let total = 0;
  for (const c of costs) {
    if (c.amountOre === 0) continue;
    b.map("fixed_costs", c.amountOre, `${c.name} ${name}`, "Fasta kostnader");
    total += c.amountOre;
  }
  b.map("fixed_payable", -total, `Fasta kostnader ${name}`, "Skuld för fasta kostnader");
  return b.done("fixed_costs", month, monthEnd(month), `Fasta kostnader ${name}`);
}

export interface PayoutInput {
  readonly id: string;
  readonly reference: string;
  readonly period: { readonly start: IsoDate; readonly end: IsoDate };
  /** Dagen pengarna kom in (Nayax: sista utbetalningsdag). */
  readonly paidOn: IsoDate;
  /** Det som kom in på kontot. */
  readonly amountOre: number;
  /** Kortavgiften (Nayax faktiska). 0 för en utbetalning som skrivits in för hand. */
  readonly cardFeeOre: number;
  /** Det Nayax drog utöver kortavgiften, en rad per sak. */
  readonly deductions: readonly {
    readonly kind: "bank_fee" | "other_fee" | "adjustment" | "vat" | "rolling" | "capital";
    readonly reason: string | null;
    readonly amountOre: number;
  }[];
  /** Inskriven för hand: avgifterna är okända. */
  readonly manual: boolean;
}

const DEDUCTION: Record<
  PayoutInput["deductions"][number]["kind"],
  { key: FortnoxAccountKey; text: string; use: string }
> = {
  bank_fee: { key: "bank_fees", text: "Bankavgift Nayax", use: "Bankavgift hos Nayax" },
  other_fee: { key: "other_fees", text: "Avgift Nayax", use: "Engångsavgifter hos Nayax" },
  adjustment: { key: "other_fees", text: "Justering Nayax", use: "Engångsavgifter hos Nayax" },
  vat: { key: "payout_vat", text: "Moms Nayax", use: "Moms som Nayax dragit" },
  rolling: {
    key: "payout_reserve",
    text: "Innehållet hos Nayax",
    use: "Pengar som Nayax håller inne",
  },
  capital: { key: "payout_capital", text: "Nayax Capital", use: "Avdrag för Nayax Capital" },
};

/** En utbetalning från Nayax: bank in, avgifter och avdrag som egna rader, mot avräkningskontot. */
export function payoutVoucher(
  p: PayoutInput,
  plan: AccountPlan,
  mapping: FortnoxMapping,
): DesiredVoucher | null {
  const description = `Utbetalning ${p.reference}`;
  if (p.amountOre < 0 || p.cardFeeOre < 0) {
    return {
      kind: "payout",
      sourceRef: p.id,
      date: p.paidOn,
      description,
      rows: [],
      hold: {
        code: "unclear_payout",
        detail: `Utbetalningen ${p.reference} har ett negativt belopp. Bokför den för hand.`,
      },
    };
  }
  const b = new Builder(plan, mapping);
  b.map("bank", p.amountOre, `Utbetalt ${p.reference}`, "Bankkontot");
  b.plan_("card_fees", p.cardFeeOre, `Kortavgift ${p.reference}`);
  let total = p.amountOre + p.cardFeeOre;
  for (const d of p.deductions) {
    if (d.amountOre === 0) continue;
    const rule = DEDUCTION[d.kind];
    b.map(rule.key, d.amountOre, d.reason ? `${rule.text}: ${d.reason}` : rule.text, rule.use);
    total += d.amountOre;
  }
  b.plan_("settlement", -total, `Avräkning ${p.reference}`);
  return b.done(
    "payout",
    p.id,
    p.paidOn,
    p.manual ? `${description} (avgifter okända)` : description,
  );
}

export interface SettlementInput {
  readonly id: string;
  readonly storeName: string;
  readonly month: string;
  readonly amountOre: number;
  readonly paidOn: IsoDate;
}

/** En betald avräkning till en butik: skulden minskar, banken minskar. */
export function settlementPaidVoucher(
  s: SettlementInput,
  plan: AccountPlan,
  mapping: FortnoxMapping,
): DesiredVoucher | null {
  if (s.amountOre <= 0) return null;
  const text = `Betalt till ${s.storeName} för ${monthText(s.month)}`;
  const b = new Builder(plan, mapping);
  b.plan_("store_payable", s.amountOre, text);
  b.map("bank", -s.amountOre, text, "Bankkontot");
  return b.done("settlement_paid", s.id, s.paidOn, capital(text));
}

/** Fingeravtrycket av det som bokförs: ändras något av det är verifikatet ett annat. */
export function voucherFingerprint(v: Pick<DesiredVoucher, "date" | "rows">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        date: v.date,
        rows: v.rows.map((r) => [r.account, r.amountOre, r.text]),
      }),
    )
    .digest("hex");
}

/** Nyckeln som gör att samma verifikat aldrig skickas två gånger. */
export function idemKey(kind: FortnoxVoucherKind, sourceRef: string, version: number): string {
  return `${kind}:${sourceRef}:v${version}`;
}

/**
 * Märket som skrivs sist i verifikatets text i Fortnox ("[BL-3f9a…]"). Med det hittas ett
 * verifikat igen om svaret från Fortnox aldrig kom fram (Fortnox har ingen egen spärr mot
 * dubbletter och ingen sökning på text: vi listar dagens verifikat och letar efter märket).
 */
export function voucherMarker(organizationId: string, key: string): string {
  const hash = createHash("sha256").update(`${organizationId}|${key}`).digest("hex").slice(0, 16);
  return `[BL-${hash}]`;
}
