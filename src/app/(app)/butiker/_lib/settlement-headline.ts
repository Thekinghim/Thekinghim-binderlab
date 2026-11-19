import { krText } from "@/reports/text";

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

const MONTH_NAMES = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/**
 * Raderna i rutan "Saknas" på Utbetalning, äldst månad först: "Sega gubben: september 2026
 * saknar avräkning. Den skulle redan ha varit betald." eller "3 butiker saknar avräkning
 * för oktober 2026." Äldre månader (före `current`) står med, så att en butik som inte
 * kunde räknas i tid inte faller bort.
 */
export function missingLines(
  missing: readonly { readonly storeName: string; readonly month: string }[],
  current: string,
): string[] {
  const byMonth = new Map<string, string[]>();
  for (const m of missing) {
    const list = byMonth.get(m.month);
    if (list) list.push(m.storeName);
    else byMonth.set(m.month, [m.storeName]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, names]) => {
      const old = month !== current;
      return names.length === 1
        ? `${names[0]}: ${monthLabel(month)} saknar avräkning.${old ? " Den skulle redan ha varit betald." : ""}`
        : `${names.length} butiker saknar avräkning för ${monthLabel(month)}.${old ? " De skulle redan ha varit betalda." : ""}`;
    });
}

/**
 * Belopp i öre som kronor med öre när beloppet inte är jämna kronor: 4 552 → "45,52 kr",
 * 150 000 → "1 500 kr". För betalningar och rättelser, där ett avrundat belopp kan få två
 * olika belopp att se lika ut (rapporten 8 072,18 kr mot dagens uträkning 8 072,40 kr) eller
 * en rättelse att se annorlunda ut än raden den kommer från (46 kr mot 45,52 kr).
 */
export function exactKr(ore: number): string {
  return krText(ore);
}
