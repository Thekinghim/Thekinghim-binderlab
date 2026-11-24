/**
 * Momsen att spara från en utbetalning från Nayax (Pengar → Utbetalningar). Rena funktioner,
 * belopp i öre.
 *
 * Den ENDA regeln för vilken moms som läggs undan (organization_settings.vat_reserve_mode):
 *
 *   'auto'      (standard) 'vmb' när bokföringen har VMB påslaget (bookkeeping_settings.
 *               vmb_enabled) ELLER butiksrapporten säger att vi säljer med VMB
 *               (organization_settings.report_vmb), annars 'standard'.
 *   'vmb'       moms på vinsten: 20 % av marginalen (försäljning − återbetalningar − vårt
 *               inköp) per kalendermånad, med underskott fört vidare (vmb.ts, vmbChain).
 *   'standard'  momsen i försäljningen med organisationens momssats (vatOfGross).
 *   'none'      ingen moms läggs undan.
 *
 * De tre befintliga valen (vmb_enabled, report_vmb, vat_rate_bp) ändras aldrig härifrån.
 */

import { vatOfGross } from "./economics";
import { vmbChain, type VmbResult } from "./vmb";

export type VatReserveSetting = "auto" | "vmb" | "standard" | "none";
export type VatReserveMode = "vmb" | "standard" | "none";

export const VAT_RESERVE_SETTINGS: readonly VatReserveSetting[] = [
  "auto",
  "vmb",
  "standard",
  "none",
];

/** Läget som gäller för organisationen (se filhuvudet). */
export function resolveVatReserveMode(
  setting: VatReserveSetting | string | null | undefined,
  flags: { readonly bookkeepingVmb: boolean; readonly reportVmb: boolean },
): VatReserveMode {
  if (setting === "vmb" || setting === "standard" || setting === "none") return setting;
  return flags.bookkeepingVmb || flags.reportVmb ? "vmb" : "standard";
}

/** Försäljning och vårt inköp i en kalendermånad av utbetalningen. */
export interface VatMonthInput {
  readonly month: string;
  readonly grossOre: number;
  readonly refundsOre: number;
  readonly costOre: number;
}

export interface VatReserveResult {
  readonly reserveOre: number;
  /** Underskott (moms på vinsten) som förs till nästa utbetalning (≥ 0). */
  readonly carryOutOre: number;
  /** Per månad: marginal och moms (för "Varför?"). */
  readonly months: readonly {
    readonly month: string;
    readonly marginOre: number;
    readonly vatOre: number;
  }[];
}

/**
 * Momsen att spara för utbetalningens månader. `carryInOre` = underskottet från förra
 * utbetalningen (bara 'vmb'). Avrundning som vmbVat: halva öre bort från noll, en gång per
 * månad och utbetalning.
 */
export function vatReserve(
  mode: VatReserveMode,
  months: readonly VatMonthInput[],
  carryInOre: number,
  vatRateBp: number,
): VatReserveResult {
  if (mode === "none" || months.length === 0) {
    return {
      reserveOre: 0,
      carryOutOre: mode === "vmb" ? Math.max(0, carryInOre) : 0,
      months: [],
    };
  }
  if (mode === "standard") {
    const out = months.map((m) => {
      const net = m.grossOre - m.refundsOre;
      return { month: m.month, marginOre: net, vatOre: net > 0 ? vatOfGross(net, vatRateBp) : 0 };
    });
    return { reserveOre: out.reduce((a, m) => a + m.vatOre, 0), carryOutOre: 0, months: out };
  }
  const chain = vmbChain(
    months.map((m) => ({
      month: m.month,
      salesInclVatOre: m.grossOre - m.refundsOre,
      purchasesOre: Math.max(0, m.costOre),
    })),
    Math.max(0, carryInOre),
  );
  const sorted = [...chain.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let last: VmbResult | null = null;
  const out = sorted.map(([month, r]) => {
    last = r;
    return { month, marginOre: r.marginOre, vatOre: r.vatOre };
  });
  const carryOutOre = last ? (last as VmbResult).carryOutOre : Math.max(0, carryInOre);
  return { reserveOre: out.reduce((a, m) => a + m.vatOre, 0), carryOutOre, months: out };
}
