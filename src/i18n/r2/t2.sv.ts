/**
 * Runda 2, spår T2: svenska texter för Att göra, Hem och mobilskalet (enkla vyn).
 *
 * Bara spår T2 ändrar den här filen och ./t2.en.ts. Texterna nås som `t.r2.t2.<nyckel>`
 * (useT() i klientkomponenter, getT() på servern). Engelskan i ./t2.en.ts måste ha exakt
 * samma nycklar: typen R2T2 och i18n.test.ts kontrollerar det.
 *
 * Småord som "3 pack", "2 omgångar" och "i Kontoret": importera `packs`, `batches`,
 * `inPlace`, `placeName` och `f` från "../words.sv". Importera aldrig från "../sv" (cirkel).
 */

export const t2 = {};

export type R2T2 = typeof t2;
