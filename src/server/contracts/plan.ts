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
