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

import { NBSP } from "@/lib/format";

import { batches, f, packs } from "../words.sv";

export const t3 = {
  /** Inköpslistan: mystery packs skrivs alltid i hela omgångar. */
  packBatches: (n: number) => `Packa ${batches(n)}`,
  /** Under 0 hemma: räkna om först. `then` är nästa steg ("Packa 2 omgångar"). */
  countFirst: (then: string) => `1. Räkna om. 2. ${then}.`,
  countFirstHint: "Antalet hemma står under 0. Räkna packen under Lager först.",

  // Inköpspriser (T3-2): rätt knapp som standard, och ett extra tryck vid ett konstigt pris.
  priceSet: "Sätt priset",
  priceSetSub: "Gäller all försäljning hittills",
  priceFixOld: "Rätta det gamla priset",
  priceFixOldSub: "Ändrar vinsten bakåt i tiden",
  priceMuchHigher: (now: string, before: string) =>
    `${now} är mycket mer än förra priset ${before}. Stämmer det?`,
  priceMuchLower: (now: string, before: string) =>
    `${now} är mycket mindre än förra priset ${before}. Stämmer det?`,
  priceAboveSale: (now: string, sale: string) =>
    `${now} är mer än packet säljs för (ca ${sale}). Stämmer det?`,
  priceSaveAnyway: "Ja, spara ändå",
  priceChange: "Ändra priset",

  // Leverans med pris (T3-3): "+ Inköp" frågar vad packen kostade.
  receiptPriceLabel: "Pris per pack",
  receiptNewPrice: (now: string, before: string) => `Nytt pris ${now} (var ${before}).`,
  receiptFirstPrice: (now: string) => `Pris ${now} per pack.`,
  receiptLeft: (left: string) => `Kvar per pack blir ${left}.`,
  receiptPriceSaved: (now: string) => `Nytt pris ${now} från i dag.`,
  receiptPriceFailed: (reason: string) => `Packen är sparade, men priset sparades inte. ${reason}`,
  receiptPriceFailedTitle: "Priset sparades inte",
  receiptPriceInvalid: "Skriv priset i kronor, t.ex. 112,50.",

  // "Beställt", "På väg" och "Kom fram" på inköpslistan (T3-4).
  ordered: "Beställt",
  boughtHere: "Köpt, har dem här",
  orderedHint: "Kommer om ca 7 dagar. Listan slutar fråga efter dem.",
  orderedSave: "Spara som beställt",
  orderedToast: (n: number, title: string) => `Beställt: ${packs(n)} ${title}.`,
  wayTitle: "På väg",
  wayLine: (n: number, when: string) => `På väg: ${f.int(n)}${NBSP}st, väntas ${when}`,
  wayLineLate: (n: number, when: string) => `På väg: ${f.int(n)}${NBSP}st, väntades ${when}`,
  wayToday: "i dag",
  weekdays: ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"],
  arrived: "Kom fram",
  arrivedHint: "Hur många pack kom, och vad kostade de?",
  arrivedSave: "Lägg in i lagret",
  gotFewer: (planned: number, got: number) =>
    `Du planerade ${f.int(planned)}, fick ${f.int(got)}. Vi ber dig köpa ${f.int(planned - got)} till.`,
  notSavedTitle: "Sparades inte",
};

export type R2T3 = typeof t3;
