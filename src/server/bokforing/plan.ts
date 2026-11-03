/**
 * Kontoplanen för månadens verifikation. Förslaget nedan följer BAS och ska kontrolleras av
 * Talenom; varje konto går att ändra under Ekonomi → Bokföring och sparas per organisation.
 * Rena funktioner.
 */

import { z } from "zod";

export const PLAN_KEYS = [
  "settlement",
  "sales_vmb",
  "vat_vmb",
  "card_fees",
  "store_share",
  "rent",
  "store_payable",
] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export interface PlanAccountInfo {
  /** Vad kontot används till (visas i tabellen). */
  readonly use: string;
  readonly account: string;
  /** Kontots namn enligt BAS (står i SIE-filen). */
  readonly name: string;
}

/** Förslaget enligt BAS. Kontrolleras av Talenom. */
export const PROPOSED_PLAN: Readonly<Record<PlanKey, PlanAccountInfo>> = {
  settlement: {
    use: "Försäljning att få från Awish",
    account: "1580",
    name: "Fordringar för kontokort och kuponger",
  },
  sales_vmb: {
    use: "Försäljning (VMB)",
    account: "3211",
    name: "Försäljning positiv VMB 25 %",
  },
  vat_vmb: { use: "VMB-moms", account: "2616", name: "Utgående moms VMB 25 %" },
  card_fees: { use: "Kortavgifter", account: "6040", name: "Kontokortsavgifter" },
  store_share: {
    use: "Butikernas andel",
    account: "6090",
    name: "Övriga försäljningskostnader",
  },
  rent: { use: "Hyra till butik", account: "5010", name: "Lokalhyra" },
  store_payable: {
    use: "Skuld till butikerna",
    account: "2990",
    name: "Övriga upplupna kostnader och förutbetalda intäkter",
  },
};

export type AccountPlan = Readonly<Record<PlanKey, string>>;

export const DEFAULT_PLAN: AccountPlan = Object.fromEntries(
  PLAN_KEYS.map((k) => [k, PROPOSED_PLAN[k].account]),
) as AccountPlan;

const account = z
  .string()
  .trim()
  .regex(/^[1-8]\d{3}$/, "Kontot ska vara fyra siffror (1000–8999).");

export const accountPlanSchema = z.object(
  Object.fromEntries(PLAN_KEYS.map((k) => [k, account])) as Record<PlanKey, typeof account>,
);

/** Kontoplanen ur databasen (jsonb). Saknade eller felaktiga värden blir förslaget. */
export function parseAccountPlan(raw: unknown): AccountPlan {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_PLAN } as Record<PlanKey, string>;
  for (const k of PLAN_KEYS) {
    const v = account.safeParse(typeof r[k] === "number" ? String(r[k]) : r[k]);
    if (v.success) out[k] = v.data;
  }
  return out;
}

/** Nycklar där kontot skiljer sig från förslaget. */
export function changedFromProposal(plan: AccountPlan): PlanKey[] {
  return PLAN_KEYS.filter((k) => plan[k] !== PROPOSED_PLAN[k].account);
}

/** Kontots namn i SIE-filen: BAS-namnet om numret är förslagets, annars användningen. */
export function accountName(plan: AccountPlan, key: PlanKey): string {
  return plan[key] === PROPOSED_PLAN[key].account
    ? PROPOSED_PLAN[key].name
    : PROPOSED_PLAN[key].use;
}
