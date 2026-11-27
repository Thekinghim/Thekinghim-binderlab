/**
 * Kort besked om en sändning till Awish, för Fyll på (toasten efter Klar och raden "Awish
 * fick inte antalen för BL-003"). Ren funktion kring resultatet från pushMachinesToAwish.
 */

import type { WebPushResult } from "./web-service";

/** Kort status om Awish-push, för Fyll på. */
export interface AwishPushStatus {
  state: "off" | "sent" | "partial" | "error";
  /**
   * Vilket besked (för översättning i Fyll på): skickat, redan rätt, inte kopplad, fel,
   * eller notSent = Awish tog inte emot allt (se `notSent`).
   */
  kind?: "sent" | "alreadyRight" | "notLinked" | "partial" | "notSent" | "error";
  /** Antal fack som skickades (kind "sent"). */
  slots?: number;
  message: string;
  /** Automater vars sändning inte gick fram (de väntar och försöks igen). */
  failedMachineIds?: string[];
  /** Pack som Awish inte tog emot, per automat och titel (kind "notSent"). */
  notSent?: NotSentLine[];
  /**
   * Automaterna (av dem beskedet gäller) där Awish fick nya antal i minst ett fack, också
   * när något annat på automaten inte gick fram. Fyll på påminner om omstart för dem.
   */
  updatedMachineIds?: string[];
}

/** En rad i beskedet om vad Awish inte tog emot. */
export interface NotSentLine {
  /** Automatens id (för raden på automaten i Fyll på). */
  readonly machineId: string;
  readonly machine: string;
  readonly titleName: string;
  readonly left: number;
  readonly reason: "capacity" | "mystery_not_empty";
}

/** "4 Mystery pack fick inte plats i BL-002" / "… skickades inte till BL-002: mystery-facket är inte tomt". */
export function notSentText(l: NotSentLine): string {
  return l.reason === "mystery_not_empty"
    ? `${l.left} ${l.titleName} skickades inte till ${l.machine}: mystery-facket är inte tomt`
    : `${l.left} ${l.titleName} fick inte plats i ${l.machine}`;
}

/** Vad man gör: räknar man facket i Fyll på skickar nästa försök det räknade antalet. */
export const NOT_SENT_ADVICE = "Räkna om facket här, så skickar appen rätt antal.";

/**
 * Hela beskedet på svenska. `slots` = fack som Awish fick (de andra facken i samma
 * påfyllning gick fram, och det ska synas).
 */
export function notSentMessage(lines: readonly NotSentLine[], slots = 0): string {
  const sent = slots > 0 ? `${slots} fack skickades till Awish. ` : "";
  return `Sparat i Binderlab. ${sent}Awish tog inte emot allt: ${lines.map(notSentText).join("; ")}. ${NOT_SENT_ADVICE}`;
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
  // Väntar gör både de som fick fel och de där Awish inte tog emot allt.
  const failed = pushed.machines
    .filter((m) => m.status === "error" || (m.notSent?.length ?? 0) > 0)
    .map((m) => m.machineId);
  const own = about ? pushed.machines.filter((m) => about.includes(m.machineId)) : pushed.machines;
  const errors = own.filter((m) => m.status === "error");
  const noMachine = own.filter((m) => m.status === "no_awish_machine");
  const slots = own.reduce((n, m) => n + m.slotsUpdated, 0);
  const updated = own.filter((m) => m.slotsUpdated > 0).map((m) => m.machineId);
  const others = {
    ...(failed.length > 0 ? { failedMachineIds: failed } : {}),
    ...(updated.length > 0 ? { updatedMachineIds: updated } : {}),
  };
  if (errors.length > 0) {
    return {
      state: "partial",
      kind: "partial",
      // Felet kan sluta med punkt ("Försök igen om en stund."): ingen dubbel punkt. Samma
      // råd som rutan på automaten ("Appen försöker igen själv"), inte ett annat.
      message: `Sparat i Binderlab. Till Awish gick det inte: ${(errors[0]?.error ?? "okänt fel").trim().replace(/[.!\s]+$/, "")}. Appen försöker igen själv.`,
      failedMachineIds: failed,
      ...(updated.length > 0 ? { updatedMachineIds: updated } : {}),
    };
  }
  // Awish tog inte emot allt: säg vad, i stället för "Sparat och skickat".
  const notSent: NotSentLine[] = own.flatMap((m) =>
    (m.notSent ?? []).map((n) => ({
      machineId: m.machineId,
      machine: m.machineCode?.trim() || "automaten",
      titleName: n.titleName,
      left: n.left,
      reason: n.reason,
    })),
  );
  if (notSent.length > 0) {
    return {
      state: "partial",
      kind: "notSent",
      slots,
      message: notSentMessage(notSent, slots),
      notSent,
      failedMachineIds: failed,
      ...(updated.length > 0 ? { updatedMachineIds: updated } : {}),
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
