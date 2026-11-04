/**
 * Vilka kostnadsrader sidorna visar: hyra och fasta kostnader bara när organisationen har
 * någon. Utan hyra i något avtal och utan fasta kostnader är inköpet (och butikens del) det
 * enda som dras, och raderna "Hyra", "Kvar efter hyra" och "Före fasta kostnader" döljs. De
 * kommer tillbaka av sig själva när en hyra eller en fast kostnad läggs in.
 *
 * Bara visning: ingen beräkning ändras (hyra och fasta kostnader är 0 när de saknas).
 * Ren modul (används både på servern och i klientkomponenter).
 */

export interface CostLines {
  /** Något avtal (nu eller tidigare) har månadshyra över 0. */
  readonly rent: boolean;
  /** Det finns minst en fast kostnad som inte är arkiverad. */
  readonly fixed: boolean;
}

/** Allt visas (standard när underlaget inte är känt, t.ex. i äldre tester). */
export const ALL_COST_LINES: CostLines = { rent: true, fixed: true };

/** Hyra och fasta kostnader ur avtalen och antalet aktiva fasta kostnader. */
export function costLinesFrom(
  agreements: readonly { readonly monthlyRentOre: number | null }[],
  activeFixedCosts: number,
): CostLines {
  return {
    rent: agreements.some((a) => (a.monthlyRentOre ?? 0) > 0),
    fixed: activeFixedCosts > 0,
  };
}
