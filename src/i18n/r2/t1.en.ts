/**
 * Round 2, track T1: English texts for the refill app, sending counts to the machines, and mystery packs.
 *
 * Same keys as ./t1.sv.ts (the type R2T1 and i18n.test.ts enforce it). Simple words for
 * someone who is not technical: never Awish, VMB, queue, margin, contract or supplier.
 * Small words such as "3 packs" and "at Kontoret": import from "../words.en".
 */

import { batches, f, inPlace } from "../words.en";
import type { R2T1 } from "./t1.sv";

export const t1: R2T1 = {
  fill: {
    packAskHave: (n, name, place) =>
      `There ${n === 1 ? "is" : "are"} ${f.int(n)} ${name} ${inPlace(place)}.`,
    packAskQuestion: (n) => (n === 1 ? "Did you pack a batch?" : `Did you pack ${batches(n)}?`),
    packAskDetail: (place) => `Yes takes the parts from the stock ${inPlace(place)}.`,
    packAskYes: (n, last) =>
      last ? `Yes, pack ${batches(n)} and refill` : `Yes, pack ${batches(n)}`,
    packAskNo: (last) => (last ? "No, just refill" : "No"),
    packing: "Packing…",
    packFailed: "Not packed",
    packFailedHint: "Nothing is saved. Press Done again.",
    mysteryReady: (n, place) =>
      n <= 0
        ? `None ready ${inPlace(place)}. Did you pack?`
        : `Only ${f.int(n)} ready ${inPlace(place)}. Did you pack?`,
    mysteryFillBatch: (batch) => `Refill one batch (${f.int(batch)})`,
    awishPending: (machine) => `${machine} did not get the new numbers.`,
    awishPendingMany: (machines) =>
      machines.length <= 3
        ? `${machines.slice(0, -1).join(", ")} and ${machines.at(-1) ?? ""} did not get the new numbers.`
        : `${f.int(machines.length)} machines did not get the new numbers.`,
    awishPendingHint: "The refill is saved here. The app tries again by itself.",
    retry: "Try again",
    retrying: "Sending…",
    retrySent: (slots) =>
      `Sent to the machine (${f.int(slots)} ${slots === 1 ? "slot" : "slots"}).`,
    retryNothing: "The machine has the right numbers now.",
    retryFailedTitle: "It did not work this time either",
    retryFailedHint: "Try again in a while. The refill is still saved here.",
  },
  mystery: {
    minus: (n, place) =>
      `The app shows ${f.int(n)} ${inPlace(place)}. Someone refilled without pressing Pack.`,
    packNow: (n) => `Pack ${batches(n)} now`,
    countNow: "Count the stock",
    askOwnerCount: "Ask the owner to count the stock.",
    packBefore: (n, weekday) => `Pack ${batches(n)} before ${weekday}.`,
    packToday: (n) => `Pack ${batches(n)} today.`,
    packNew: (n, machine) => `New machine ${machine}: pack ${batches(n)}.`,
    slotEmpty: (machine) => `${machine} is empty.`,
    slotNew: (machine) => `${machine} is new and empty.`,
    slotTomorrow: (machine) => `${machine} is empty tomorrow.`,
    slotInDays: (machine, days) => `${machine} is empty in about ${f.int(days)} days.`,
    moreSlots: (n) =>
      n === 1
        ? "1 more machine runs out this week."
        : `${f.int(n)} more machines run out this week.`,
    readyHome: (n) =>
      n === 1 ? "1 batch is packed and ready." : `${f.int(n)} batches are packed and ready.`,
    nothingToPack: "Nothing to pack this week.",
    tooLateToUndo: "Older packings can no longer be undone.",
    countInstead: "Count the stock instead",
    countInsteadText: "Count the stock instead.",
    weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  },
};

/**
 * Swedish messages from this track's server actions and database functions, in English:
 * the exact Swedish text → the English text. `t.serverError(message)` looks here after the
 * shared table in ../en.ts, so the track never edits that table. Same simple words as above.
 */
export const serverErrors: Record<string, string> = {};
