/**
 * Rena regler för Skapa avtal: hur butikens villkor (store_agreements) ändras när ett avtal
 * skapas från mallen, och avtalets status. Testas i plan.test.ts.
 */

import { addDays, type IsoDate } from "@/domain";

export interface AgreementSpan {
  readonly id: string;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
}

/**
 * Vad som görs med villkoren när avtalet gäller från `validFrom` tills vidare:
 * - `update`: villkor som börjar samma dag (och inte slutar) skrivs om till vinstdelning.
 * - `insert`: nytt villkor; ett villkor som gäller dagen före avslutas dagen före (`close`).
 * - fel: ett villkor börjar senare, eller slutar på en bestämd dag efter starten.
 */
export type AgreementPlan =
  | { readonly kind: "update"; readonly id: string }
  | { readonly kind: "insert"; readonly close: { id: string; validTo: IsoDate } | null }
  | { readonly kind: "conflict"; readonly validFrom: IsoDate };

export function planContractAgreement(
  existing: readonly AgreementSpan[],
  validFrom: IsoDate,
): AgreementPlan {
  const sorted = [...existing].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
  let close: { id: string; validTo: IsoDate } | null = null;
  for (const a of sorted) {
    const end = a.validTo ?? "9999-12-31";
    if (end < validFrom) continue;
    if (a.validFrom === validFrom && a.validTo === null) return { kind: "update", id: a.id };
    if (a.validFrom < validFrom && a.validTo === null) {
      close = { id: a.id, validTo: addDays(validFrom, -1) };
      continue;
    }
    // Börjar på eller efter startdagen, eller har en egen slutdag efter den.
    return { kind: "conflict", validFrom: a.validFrom };
  }
  return { kind: "insert", close };
}

/**
 * Första dagen före i dag som får ny ersättning (villkoren räknas om bakåt), eller null om
 * bara i dag och framåt påverkas.
 */
export function backdatedFrom(validFrom: IsoDate, today: IsoDate): IsoDate | null {
  return validFrom < today ? validFrom : null;
}

/**
 * Föreslagen startdag i Skapa kontrakt: kontraktet ska täcka allt automaten har sålt i
 * butiken (Sega gubben sålde från 14 okt. men kontraktet föreslog 3 nov., i dag).
 * - Butiken har öppna villkor: deras startdag (kontraktet skriver om dem från början; en
 *   senare dag skulle avsluta dem och lämna försäljningen före utan kontrakt).
 * - Annars första försäljningen, eller första placeringen, men aldrig före dagen efter
 *   butikens senaste avslutade villkor (de krockar annars, se planContractAgreement).
 * - Inget av det, eller en dag efter i dag: i dag.
 */
export function suggestContractStart(args: {
  readonly today: IsoDate;
  /** Startdagen för butikens villkor utan slutdag, eller null. */
  readonly openTermsFrom: IsoDate | null;
  /** Sista dagen för butikens senaste avslutade villkor, eller null. */
  readonly closedUntil: IsoDate | null;
  readonly firstSale: IsoDate | null;
  readonly firstPlacement: IsoDate | null;
}): IsoDate {
  if (args.openTermsFrom !== null) return args.openTermsFrom;
  const seen = [args.firstSale, args.firstPlacement].filter((d): d is IsoDate => d !== null);
  let start = seen.sort()[0] ?? args.today;
  if (args.closedUntil !== null && start <= args.closedUntil) start = addDays(args.closedUntil, 1);
  return start > args.today ? args.today : start;
}

export type ContractStatus = "draft" | "sent" | "signed";

export const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = {
  draft: "Utkast",
  sent: "Skickat",
  signed: "Signerat",
};

/** Status för ett avtal från mallen; null för avtal som registrerats för hand. */
export function contractStatus(c: {
  readonly template: string | null;
  readonly sentAt: Date | string | null;
  readonly signedAt: Date | string | null;
}): ContractStatus | null {
  if (c.template === null) return null;
  if (c.signedAt !== null) return "signed";
  if (c.sentAt !== null) return "sent";
  return "draft";
}
