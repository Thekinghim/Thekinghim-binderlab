/**
 * Runda 2, spår T2: svenska texter för Att göra, Hem och mobilskalet (enkla vyn).
 *
 * Bara spår T2 ändrar den här filen och ./t2.en.ts. Texterna nås som `t.r2.t2.<nyckel>`
 * (useT() i klientkomponenter, getT() på servern). Engelskan i ./t2.en.ts måste ha exakt
 * samma nycklar: typen R2T2 och i18n.test.ts kontrollerar det.
 *
 * Serverns felmeddelanden på engelska läggs i `serverErrors` i ./t2.en.ts, inte i ../en.ts.
 * Tester av texterna kan ligga i en egen fil här (./t2.test.ts), inte i ../i18n.test.ts.
 *
 * Småord som "3 pack", "2 omgångar" och "i Kontoret": importera `packs`, `batches`,
 * `inPlace`, `placeName` och `f` från "../words.sv". Importera aldrig från "../sv" (cirkel).
 */

export const t2 = {};

export type R2T2 = typeof t2;
