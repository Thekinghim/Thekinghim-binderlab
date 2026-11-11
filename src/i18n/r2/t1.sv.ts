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

import { NBSP } from "@/lib/format";

import { batches, f, inPlace } from "../words.sv";

export const t1 = {
  /** Fyll på: frågan "Packade du en omgång?" när mystery packs inte finns färdiga i lagret. */
  fill: {
    /** "Det finns 0 Mystery Pack i Kontoret." */
    packAskHave: (n: number, name: string, place: string) =>
      `Det finns ${f.int(n)} ${name} ${inPlace(place)}.`,
    packAskQuestion: (n: number) =>
      n === 1 ? "Packade du en omgång?" : `Packade du ${batches(n)}?`,
    /** Vad Ja gör, så att ingen behöver gissa. */
    packAskDetail: (place: string) => `Ja tar delarna ur lagret ${inPlace(place)}.`,
    /** `last`: sista frågan, då sparas påfyllningen också. */
    packAskYes: (n: number, last: boolean) =>
      last ? `Ja, packa ${batches(n)} och fyll på` : `Ja, packa ${batches(n)}`,
    packAskNo: (last: boolean): string => (last ? "Nej, fyll bara på" : "Nej"),
    packing: "Packar…",
    packFailed: "Packades inte",
    packFailedHint: "Inget är sparat. Tryck Klar igen.",
    /** Tomt mystery-fack och ingen hel omgång färdig: "0 färdiga i Kontoret." */
    mysteryReady: (n: number, place: string) => `${f.int(n)} färdiga ${inPlace(place)}.`,
    mysteryFillBatch: (batch: number) => `Fyll på en omgång (${f.int(batch)}${NBSP}st)`,
  },
  /** Mystery packs (Vårt lager): minus i lagret och vad som ska packas. */
  mystery: {
    /** "Det står −14 i Kontoret. Någon har fyllt på utan att trycka Packa." */
    minus: (n: number, place: string) =>
      `Det står ${f.int(n)} ${inPlace(place)}. Någon har fyllt på utan att trycka Packa.`,
    packNow: (n: number) => `Packa ${batches(n)} nu`,
    countNow: "Räkna om lagret",
    askOwnerCount: "Be ägaren räkna om lagret.",
    /** "Packa 1 omgång före fredag." */
    packBefore: (n: number, weekday: string) => `Packa ${batches(n)} före ${weekday}.`,
    packToday: (n: number) => `Packa ${batches(n)} i dag.`,
    /** Ny automat utan historik, tomt fack. */
    packNew: (n: number, machine: string) => `Ny automat ${machine}: packa ${batches(n)}.`,
    slotEmpty: (machine: string) => `${machine} är tom.`,
    slotTomorrow: (machine: string) => `${machine} är tom i morgon.`,
    slotInDays: (machine: string, days: number) => `${machine} är tom om ca ${f.int(days)} dagar.`,
    moreSlots: (n: number) =>
      n === 1
        ? "1 automat till blir tom i veckan."
        : `${f.int(n)} automater till blir tomma i veckan.`,
    readyHome: (n: number) =>
      n === 1 ? "1 omgång ligger klar hemma." : `${f.int(n)} omgångar ligger klara hemma.`,
    nothingToPack: "Inget att packa den här veckan.",
    /** Måndag först. */
    weekdays: [
      "måndag",
      "tisdag",
      "onsdag",
      "torsdag",
      "fredag",
      "lördag",
      "söndag",
    ] as readonly string[],
  },
};

export type R2T1 = typeof t1;
