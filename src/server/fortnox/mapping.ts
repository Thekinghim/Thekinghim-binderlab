/**
 * Kontomappningen för Fortnox: kontona som den befintliga kontoplanen (Ekonomi → Bokföring,
 * src/server/bokforing/plan.ts) inte har, och vilka sorters verifikat som skickas. Förslagen
 * följer BAS och ska kontrolleras av redovisningsbyrån; allt går att ändra under
 * Datakällor → Fortnox och sparas per organisation (fortnox_connections.mapping).
 *
 * Rena funktioner.
 */

import { z } from "zod";

/** Konton utöver kontoplanen. `null` = inget förslag: verifikatet stoppas tills kontot valts. */
export const FORTNOX_ACCOUNT_KEYS = [
  "bank",
  "bank_fees",
  "other_fees",
  "payout_vat",
  "payout_reserve",
  "payout_capital",
  "vat_out",
  "cogs",
  "inventory",
  "fixed_costs",
  "fixed_payable",
] as const;
export type FortnoxAccountKey = (typeof FORTNOX_ACCOUNT_KEYS)[number];

export interface FortnoxAccountInfo {
  /** Vad kontot används till (visas i inställningarna). */
  readonly use: string;
  /** Förslaget enligt BAS, eller null när appen inte ska gissa. */
  readonly account: string | null;
  readonly name: string;
}

export const FORTNOX_ACCOUNTS: Readonly<Record<FortnoxAccountKey, FortnoxAccountInfo>> = {
  bank: { use: "Bankkontot som Nayax betalar till", account: "1930", name: "Företagskonto" },
  bank_fees: { use: "Bankavgift hos Nayax", account: "6570", name: "Bankkostnader" },
  other_fees: {
    use: "Engångsavgifter och justeringar hos Nayax",
    account: "6590",
    name: "Övriga externa tjänster",
  },
  payout_vat: { use: "Moms som Nayax dragit", account: null, name: "Moms hos Nayax" },
  payout_reserve: {
    use: "Pengar som Nayax håller inne (rolling balance)",
    account: null,
    name: "Innehållet hos Nayax",
  },
  payout_capital: {
    use: "Avdrag för Nayax Capital",
    account: null,
    name: "Nayax Capital",
  },
  vat_out: {
    use: "Utgående moms (bara när momsen i Inställningar inte är 0)",
    account: "2611",
    name: "Utgående moms på försäljning inom Sverige, 25 %",
  },
  cogs: {
    use: "Inköpsvärde för sålda pack",
    account: "4960",
    name: "Förändring av lager av handelsvaror",
  },
  inventory: { use: "Lager", account: "1460", name: "Lager av handelsvaror" },
  fixed_costs: { use: "Fasta kostnader", account: "6990", name: "Övriga externa kostnader" },
  fixed_payable: {
    use: "Skuld för fasta kostnader",
    account: "2990",
    name: "Övriga upplupna kostnader och förutbetalda intäkter",
  },
};

export const FORTNOX_KINDS = [
  "sales",
  "payout",
  "store_share",
  "settlement_paid",
  "cogs",
  "fixed_costs",
] as const;
export type FortnoxVoucherKind = (typeof FORTNOX_KINDS)[number];

export interface FortnoxKindInfo {
  readonly label: string;
  readonly help: string;
  /** Skickas om inget annat valts. */
  readonly on: boolean;
}

/**
 * Inköpsvärde och fasta kostnader är avstängda från början: bokför redovisningsbyrån redan
 * leverantörsfakturorna som kostnad skulle samma kostnad annars bokföras två gånger.
 */
export const FORTNOX_KIND_INFO: Readonly<Record<FortnoxVoucherKind, FortnoxKindInfo>> = {
  sales: {
    label: "Försäljning",
    help: "Ett verifikat per månad, en rad per automat.",
    on: true,
  },
  payout: {
    label: "Utbetalning från Nayax",
    help: "Pengarna in på banken, kortavgift, bankavgift och engångsavgifter som egna rader.",
    on: true,
  },
  store_share: {
    label: "Butikernas andel",
    help: "Månadens andel och hyra per butik, som skuld till butiken.",
    on: true,
  },
  settlement_paid: {
    label: "Betalning till butik",
    help: "När en avräkning markeras som betald.",
    on: true,
  },
  cogs: {
    label: "Inköpsvärde för sålda pack",
    help: "Slå bara på om inköpen bokförs som lager. Bokförs fakturorna som kostnad blir det dubbelt.",
    on: false,
  },
  fixed_costs: {
    label: "Fasta kostnader",
    help: "Slå bara på om fakturorna för de fasta kostnaderna inte bokförs på annat sätt.",
    on: false,
  },
};

export interface FortnoxMapping {
  readonly accounts: Readonly<Record<FortnoxAccountKey, string | null>>;
  readonly kinds: Readonly<Record<FortnoxVoucherKind, boolean>>;
}

const account = z
  .string()
  .trim()
  .regex(/^[1-8]\d{3}$/, "Kontot ska vara fyra siffror (1000–8999).");

export const DEFAULT_MAPPING: FortnoxMapping = {
  accounts: Object.fromEntries(
    FORTNOX_ACCOUNT_KEYS.map((k) => [k, FORTNOX_ACCOUNTS[k].account]),
  ) as Record<FortnoxAccountKey, string | null>,
  kinds: Object.fromEntries(FORTNOX_KINDS.map((k) => [k, FORTNOX_KIND_INFO[k].on])) as Record<
    FortnoxVoucherKind,
    boolean
  >,
};

/** Mappningen ur databasen (jsonb). Saknade eller felaktiga värden blir förslaget. */
export function parseMapping(raw: unknown): FortnoxMapping {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const a = (r.accounts && typeof r.accounts === "object" ? r.accounts : {}) as Record<
    string,
    unknown
  >;
  const k = (r.kinds && typeof r.kinds === "object" ? r.kinds : {}) as Record<string, unknown>;
  const accounts = { ...DEFAULT_MAPPING.accounts } as Record<FortnoxAccountKey, string | null>;
  for (const key of FORTNOX_ACCOUNT_KEYS) {
    if (a[key] === null) accounts[key] = null;
    else {
      const v = account.safeParse(typeof a[key] === "number" ? String(a[key]) : a[key]);
      if (v.success) accounts[key] = v.data;
    }
  }
  const kinds = { ...DEFAULT_MAPPING.kinds } as Record<FortnoxVoucherKind, boolean>;
  for (const key of FORTNOX_KINDS) if (typeof k[key] === "boolean") kinds[key] = k[key];
  return { accounts, kinds };
}

/** Det som sparas från inställningarna: tomt fält = inget konto valt. */
export const mappingInputSchema = z.object({
  accounts: z.object(
    Object.fromEntries(
      FORTNOX_ACCOUNT_KEYS.map((k) => [
        k,
        z.union([account, z.literal("").transform(() => null), z.null()]),
      ]),
    ) as unknown as Record<FortnoxAccountKey, z.ZodType<string | null>>,
  ),
  kinds: z.object(
    Object.fromEntries(FORTNOX_KINDS.map((k) => [k, z.boolean()])) as Record<
      FortnoxVoucherKind,
      z.ZodBoolean
    >,
  ),
});
