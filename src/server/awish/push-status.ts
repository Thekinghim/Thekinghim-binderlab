/**
 * Kort besked om en sändning till Awish, för Fyll på (toasten efter Klar och raden "Awish
 * fick inte antalen för BL-003"). Ren funktion kring resultatet från pushMachinesToAwish.
 */

import type { WebPushResult } from "./web-service";

/** Kort status om Awish-push, för Fyll på. */
export interface AwishPushStatus {
  state: "off" | "sent" | "partial" | "error";
  /** Vilket besked (för översättning i Fyll på): skickat, redan rätt, inte kopplad, fel. */
  kind?: "sent" | "alreadyRight" | "notLinked" | "partial" | "error";
  /** Antal fack som skickades (kind "sent"). */
  slots?: number;
  message: string;
  /** Automater vars sändning inte gick fram (de väntar och försöks igen). */
  failedMachineIds?: string[];
}

/**
 * `about`: automaterna beskedet gäller (de som just fylldes på). Andra automater i samma
 * körning (de som väntade sedan förut och försöktes igen) ändrar inte beskedet: en
 * påfyllning som gick fram ska inte heta "Till Awish gick det inte" för att en ANNAN automat
 * fortfarande väntar. Alla som inte gick fram står ändå i `failedMachineIds`, så att raden på
 * dem ligger kvar. Utelämnat = alla automater i körningen.
 */
export function summariseAwishPush(
  pushed: WebPushResult,
  about?: readonly string[],
): AwishPushStatus | undefined {
  if (pushed.status === "off") {
    // Push avstängd eller ingen inloggning: inget att visa i appen.
    return undefined;
  }
  const failed = pushed.machines.filter((m) => m.status === "error").map((m) => m.machineId);
  const own = about ? pushed.machines.filter((m) => about.includes(m.machineId)) : pushed.machines;
  const errors = own.filter((m) => m.status === "error");
  const noMachine = own.filter((m) => m.status === "no_awish_machine");
  const slots = own.reduce((n, m) => n + m.slotsUpdated, 0);
  const others = failed.length > 0 ? { failedMachineIds: failed } : {};
  if (errors.length > 0) {
    return {
      state: "partial",
      kind: "partial",
      message: `Sparat i Binderlab. Till Awish gick det inte: ${errors[0]?.error ?? "okänt fel"}. Tryck Försök igen på automaten.`,
      failedMachineIds: failed,
    };
  }
  if (noMachine.length > 0 && slots === 0) {
    return {
      state: "partial",
      kind: "notLinked",
      message: "Sparat i Binderlab. Automaten är inte kopplad till Awish ännu.",
      ...others,
    };
  }
  if (slots === 0) {
    return {
      state: "sent",
      kind: "alreadyRight",
      message: "Sparat. Awish hade redan rätt antal.",
      ...others,
    };
  }
  return {
    state: "sent",
    kind: "sent",
    slots,
    message: `Sparat och skickat till Awish (${slots} fack).`,
    ...others,
  };
}
