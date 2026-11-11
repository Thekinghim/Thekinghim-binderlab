/**
 * Runda 2, spår T1: svenska texter för Fyll på-appen, Awish-sändningen och mystery packs.
 *
 * Bara spår T1 ändrar den här filen och ./t1.en.ts. Texterna nås som `t.r2.t1.<nyckel>`
 * (useT() i klientkomponenter, getT() på servern). Engelskan i ./t1.en.ts måste ha exakt
 * samma nycklar: typen R2T1 och i18n.test.ts kontrollerar det.
 *
 * Serverns felmeddelanden på engelska läggs i `serverErrors` i ./t1.en.ts, inte i ../en.ts.
 * Tester av texterna kan ligga i en egen fil här (./t1.test.ts), inte i ../i18n.test.ts.
 *
 * Småord som "3 pack", "2 omgångar" och "i Kontoret": importera `packs`, `batches`,
 * `inPlace`, `placeName` och `f` från "../words.sv". Importera aldrig från "../sv" (cirkel).
 */

export const t1 = {};

export type R2T1 = typeof t1;
