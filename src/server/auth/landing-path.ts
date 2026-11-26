/** Valet av sida efter inloggningen (ren funktion; läsningen står i ./landing.ts). */

export interface LandingFacts {
  /** Medlem i minst en organisation (en approll). */
  readonly member: boolean;
  /** Påfyllare i butiken vid minst en automat. */
  readonly staff: boolean;
  /** Butiksanvändare i minst en butik. */
  readonly store: boolean;
}

function isPathOrBelow(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`);
}

/** Sökvägen efter inloggningen (`next` är redan kontrollerad med safeRedirectPath). */
export function landingPath(next: string, facts: LandingFacts): string {
  if (facts.member) return next;
  if (facts.staff) return isPathOrBelow(next, "/pafyll") ? next : "/pafyll";
  if (facts.store) return isPathOrBelow(next, "/portal") ? next : "/portal";
  return next;
}
