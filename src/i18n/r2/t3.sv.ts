/**
 * Runda 2, spår T3: svenska texter för lager och inköp (Vårt lager, Inköpslistan, Inköpspriser).
 *
 * Bara spår T3 ändrar den här filen och ./t3.en.ts. Texterna nås som `t.r2.t3.<nyckel>`
 * (useT() i klientkomponenter, getT() på servern). Engelskan i ./t3.en.ts måste ha exakt
 * samma nycklar: typen R2T3 och i18n.test.ts kontrollerar det.
 *
 * Serverns felmeddelanden på engelska läggs i `serverErrors` i ./t3.en.ts, inte i ../en.ts.
 * Tester av texterna kan ligga i en egen fil här (./t3.test.ts), inte i ../i18n.test.ts.
 *
 * Småord som "3 pack", "2 omgångar" och "i Kontoret": importera `packs`, `batches`,
 * `inPlace`, `placeName` och `f` från "../words.sv". Importera aldrig från "../sv" (cirkel).
 */

import { batches } from "../words.sv";

export const t3 = {
  /** Inköpslistan: mystery packs skrivs alltid i hela omgångar. */
  packBatches: (n: number) => `Packa ${batches(n)}`,
  /** Under 0 hemma: räkna om först. `then` är nästa steg ("Packa 2 omgångar"). */
  countFirst: (then: string) => `1. Räkna om. 2. ${then}.`,
  countFirstHint: "Antalet hemma står under 0. Räkna packen under Lager först.",
};

export type R2T3 = typeof t3;
