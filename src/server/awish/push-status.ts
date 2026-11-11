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

export function summariseAwishPush(pushed: WebPushResult): AwishPushStatus | undefined {
  if (pushed.status === "off") {
    // Push avstängd eller ingen inloggning: inget att visa i appen.
    return undefined;
  }
  const errors = pushed.machines.filter((m) => m.status === "error");
  const noMachine = pushed.machines.filter((m) => m.status === "no_awish_machine");
  const slots = pushed.machines.reduce((n, m) => n + m.slotsUpdated, 0);
  if (errors.length > 0) {
    return {
      state: "partial",
      kind: "partial",
      message: `Sparat i Binderlab. Till Awish gick det inte: ${errors[0]?.error ?? "okänt fel"}. Tryck Försök igen på automaten.`,
      failedMachineIds: errors.map((m) => m.machineId),
    };
  }
  if (noMachine.length > 0 && slots === 0) {
    return {
      state: "partial",
      kind: "notLinked",
      message: "Sparat i Binderlab. Automaten är inte kopplad till Awish ännu.",
    };
  }
  if (slots === 0) {
    return { state: "sent", kind: "alreadyRight", message: "Sparat. Awish hade redan rätt antal." };
  }
  return {
    state: "sent",
    kind: "sent",
    slots,
    message: `Sparat och skickat till Awish (${slots} fack).`,
  };
}
