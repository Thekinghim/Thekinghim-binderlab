/**
 * Flikarna på Ekonomi. "Fasta kostnader" visas bara när organisationen har en fast kostnad
 * som inte är arkiverad (samma regel som src/lib/cost-lines.ts: `costLinesFrom(…).fixed`),
 * eller när fliken redan är vald (länken "Lägg till fast kostnad" och Lönsamhet leder dit).
 * Utan fasta kostnader står i stället en liten länk "Lägg till fast kostnad" för den som
 * får ändra. Ren och klientsäker.
 */

import { costLinesFrom } from "@/lib/cost-lines";

export type EconomyView = "avstamning" | "kassaflode" | "fasta" | "bokforing";

export interface EconomyTab {
  readonly value: EconomyView;
  readonly label: string;
}

/** Fasta kostnader som räknas: de som inte är arkiverade. */
export function hasFixedCosts(costs: readonly { readonly archived: boolean }[]): boolean {
  return costLinesFrom([], costs.filter((c) => !c.archived).length).fixed;
}

/** Flikarna i ordning. Fasta kostnader bara med en aktiv fast kostnad eller vald flik. */
export function economyTabs(fixed: boolean, view: EconomyView): EconomyTab[] {
  return [
    { value: "avstamning", label: "Avstämning" },
    { value: "kassaflode", label: "Kassaflöde" },
    ...(fixed || view === "fasta" ? [{ value: "fasta" as const, label: "Fasta kostnader" }] : []),
  ];
}

/** Länken "Lägg till fast kostnad": utan fasta kostnader, för den som får ändra. */
export function showAddFixedLink(fixed: boolean, view: EconomyView, canEdit: boolean): boolean {
  return canEdit && !fixed && view !== "fasta" && view !== "bokforing";
}
