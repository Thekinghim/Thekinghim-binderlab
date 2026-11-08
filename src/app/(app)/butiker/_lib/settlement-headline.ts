/**
 * Rubriken på Butiker → Utbetalning när inget går att betala just nu. "Allt är betalt."
 * får bara stå när ingen avräkning saknas eller är spärrad: en butik vars avräkning inte
 * kan räknas (t.ex. saknat inköpspris) har inte fått betalt. Ren.
 */
export function settlementIdleHeadline(input: {
  /** Obetalda avräkningar som inte kan räknas nu. */
  readonly blocked: number;
  /** Butiker utan avräkning för månaden som inte heller kan räknas. */
  readonly failed: number;
  /** Butiker utan avräkning för månaden (kan skapas). */
  readonly missing: number;
  /** "oktober 2026" */
  readonly monthLabel: string;
}): { title: string; aside: string } {
  const notReady = input.blocked + input.failed;
  if (notReady > 0) {
    return {
      title: "Inte klart än.",
      aside: `${notReady === 1 ? "1 avräkning" : `${notReady} avräkningar`} kan inte räknas än.`,
    };
  }
  if (input.missing > 0) {
    return {
      title: "Inte avräknat än.",
      aside: `Skapa avräkningarna för ${input.monthLabel}.`,
    };
  }
  return { title: "Allt är betalt.", aside: "Nästa avräkning kommer den 1:a." };
}

/**
 * En butik utan avtal i avräkningsmånaden (räknas som 0 % de dagarna), som raden i
 * varningen på Utbetalning och i frågan före "Skapa ändå".
 */
export function noAgreementLine(g: {
  readonly storeName: string;
  readonly days: number;
  readonly whole: boolean;
}): string {
  return g.whole
    ? `${g.storeName}: inget avtal – får 0\u00a0kr.`
    : `${g.storeName}: inget avtal ${g.days === 1 ? "1\u00a0dag" : `${g.days}\u00a0dagar`} – 0\u00a0% de dagarna.`;
}
