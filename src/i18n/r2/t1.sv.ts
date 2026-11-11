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
    /** Tomt mystery-fack och ingen hel omgång färdig: "Inga färdiga i Kontoret. Har du packat?" */
    mysteryReady: (n: number, place: string) =>
      n <= 0
        ? `Inga färdiga ${inPlace(place)}. Har du packat?`
        : `Bara ${f.int(n)} färdiga ${inPlace(place)}. Har du packat?`,
    mysteryFillBatch: (batch: number) => `Fyll på en omgång (${f.int(batch)}${NBSP}st)`,
    /** Sändningen till Awish gick inte fram: raden på automaten tills den gått fram. */
    awishPending: (machine: string) => `Awish fick inte antalen för ${machine}.`,
    /** Flera automater väntar: högst tre koder skrivs ut, annars antalet. */
    awishPendingMany: (machines: readonly string[]) =>
      machines.length <= 3
        ? `Awish fick inte antalen för ${machines.slice(0, -1).join(", ")} och ${machines.at(-1) ?? ""}.`
        : `Awish fick inte antalen för ${f.int(machines.length)} automater.`,
    awishPendingHint: "Påfyllningen är sparad här. Appen försöker igen själv.",
    retry: "Försök igen",
    retrying: "Skickar…",
    retrySent: (slots: number) => `Skickat till Awish (${f.int(slots)} fack).`,
    retryNothing: "Awish har rätt antal nu.",
    retryFailedTitle: "Det gick inte nu heller",
    retryFailedHint: "Försök igen om en stund. Påfyllningen ligger kvar här.",
  },
  /** Mystery packs (Vårt lager): minus i lagret och vad som ska packas. */
  mystery: {
    /** "Det står −14 i Kontoret. Någon har fyllt på utan att trycka Packa." */
    minus: (n: number, place: string) =>
      `Det står ${f.int(n)} ${inPlace(place)}. Någon har fyllt på utan att trycka Packa.`,
    /** Minuset är inte hela omgångar (−1): då är det inte en påfyllning utan Packa. */
    minusOdd: (n: number, place: string) =>
      `Det står ${f.int(n)} ${inPlace(place)}. Det kan inte stämma.`,
    packNow: (n: number) => `Packa ${batches(n)} nu`,
    countNow: "Räkna om lagret",
    askOwnerCount: "Be ägaren räkna om lagret.",
    /** "Packa 1 omgång före fredag." */
    packBefore: (n: number, weekday: string) => `Packa ${batches(n)} före ${weekday}.`,
    packToday: (n: number) => `Packa ${batches(n)} i dag.`,
    /** Ny automat utan historik, tomt fack. */
    packNew: (n: number, machine: string) => `Ny automat ${machine}: packa ${batches(n)}.`,
    slotEmpty: (machine: string) => `${machine} är tom.`,
    /** Ny automat och fler fack samtidigt: "Packa 2 omgångar nu. BL-004 är ny och tom." */
    slotNew: (machine: string) => `${machine} är ny och tom.`,
    slotTomorrow: (machine: string) => `${machine} är tom i morgon.`,
    slotInDays: (machine: string, days: number) => `${machine} är tom om ca ${f.int(days)} dagar.`,
    moreSlots: (n: number) =>
      n === 1
        ? "1 automat till blir tom i veckan."
        : `${f.int(n)} automater till blir tomma i veckan.`,
    readyHome: (n: number) =>
      n === 1 ? "1 omgång ligger klar hemma." : `${f.int(n)} omgångar ligger klara hemma.`,
    nothingToPack: "Inget att packa den här veckan.",
    /** Under "Senast packat" när en packning är äldre än 30 minuter. */
    tooLateToUndo: "Äldre packningar går inte att ångra längre.",
    countInstead: "Räkna om lagret i stället",
    countInsteadText: "Räkna om lagret i stället.",
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
