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

export const t3 = {};

export type R2T3 = typeof t3;
