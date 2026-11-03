/**
 * Villkoren i Skapa kontrakt och Ny butik som formuläret visar dem (text i fälten), och
 * vägen därifrån till kontraktets villkor: snabbval, kontroll (samma schema som servern,
 * contractTermsSchema) och klartexten i listan. Rent, testas i terms.test.ts.
 */

import {
  CONTRACT_PRESETS,
  contractTermsPlain,
  type ContractPreset,
  type ContractShareBase,
  type ContractTerms,
} from "@/reports/contract-pdf";

import { contractTermsSchema } from "../../butiker/_lib/validation";

export type { ContractPreset };

/** Formulärets värden. `preset` = snabbvalet som senast trycktes (för markeringen). */
export interface TermsDraft {
  readonly preset: ContractPreset | null;
  /** Butikens andel i procent, som den skrivs ("50", "12,5"). Tom = ingen andel. */
  readonly share: string;
  readonly base: ContractShareBase;
  /** Fast hyra i kronor per månad. Tom = ingen. */
  readonly rent: string;
  readonly loss: "zero" | "proportional";
  readonly vmb: boolean;
  readonly special: string;
}

/** Ordningen på snabbvalen. */
export const PRESET_ORDER: readonly ContractPreset[] = ["split", "rent", "sales"];

/** Förvalet: 50/50 av vinsten efter kostnader. */
export const DEFAULT_TERMS: TermsDraft = presetDraft("split");

/** Villkoren efter ett snabbval. Särskilda villkor behålls. */
export function presetDraft(preset: ContractPreset, previous?: TermsDraft): TermsDraft {
  const t = CONTRACT_PRESETS[preset].terms;
  return {
    preset,
    share: t.shareBp === null ? "" : String(t.shareBp / 100),
    base: t.base ?? "profit_after_costs",
    rent: "",
    loss: t.lossTreatment,
    vmb: t.vmbBeforeSplit === true,
    special: previous?.special ?? "",
  };
}

/** Det som skickas till servern (createContract, `terms`). */
export function termsPayload(d: TermsDraft) {
  return {
    share: d.share,
    base: d.base,
    rent: d.rent,
    loss: d.loss,
    vmbBeforeSplit: d.vmb,
    specialTerms: d.special,
  };
}

export type CheckedTerms =
  | {
      readonly ok: true;
      readonly terms: ContractTerms;
      readonly specialTerms: string | null;
      /** "50 % av vinsten efter kostnader". */
      readonly plain: string;
    }
  | { readonly ok: false; readonly message: string; readonly field: "share" | "rent" | "special" };

/** Kontrollerar villkoren med samma regler som servern och ger klartexten. */
export function checkTerms(d: TermsDraft): CheckedTerms {
  if (d.preset === "sales" && d.share.trim() === "") {
    return { ok: false, message: "Skriv butikens andel i procent.", field: "share" };
  }
  if (d.preset === "rent" && d.rent.trim() === "" && d.share.trim() === "") {
    return { ok: false, message: "Skriv hyran per månad.", field: "rent" };
  }
  const r = contractTermsSchema.safeParse(termsPayload(d));
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue?.path[0];
    return {
      ok: false,
      message: issue?.message ?? "Kontrollera villkoren.",
      field: path === "rent" ? "rent" : path === "specialTerms" ? "special" : "share",
    };
  }
  const { specialTerms, ...terms } = r.data;
  return { ok: true, terms, specialTerms, plain: contractTermsPlain(terms) };
}

/**
 * Villkoren som Ny butik-guidens första sparning tar (butik + preliminära villkor). Hela
 * villkoren (hyra ovanpå andel, vid förlust, VMB, särskilda villkor) skrivs sedan av
 * kontraktet, som börjar samma dag och skriver om dem.
 */
export function guideTerms(d: TermsDraft): { preset: ContractPreset; share: string; rent: string } {
  const share = d.share.trim();
  if (share !== "") {
    return { preset: d.base === "net_excl_vat" ? "sales" : "split", share, rent: "" };
  }
  return { preset: "rent", share: "", rent: d.rent.trim() };
}

/** Kontraktets HTML som förhandsvisning i en ram: luft runt texten och en kolumn på mobil. */
export function previewHtml(html: string): string {
  return html.replace(
    "</head>",
    "<style>body{padding:16px}@media (max-width:640px){body{font-size:9pt}h1{font-size:15pt}.parties,.signs{grid-template-columns:1fr}}</style></head>",
  );
}
