/**
 * Round 2, track T3: English texts for stock and buying (stock, buy list, purchase prices).
 *
 * Same keys as ./t3.sv.ts (the type R2T3 and i18n.test.ts enforce it). Simple words for
 * someone who is not technical: never Awish, VMB, queue, margin, contract or supplier.
 * Small words such as "3 packs" and "at Kontoret": import from "../words.en".
 */

import { batches, f, packs } from "../words.en";
import type { R2T3 } from "./t3.sv";

export const t3: R2T3 = {
  packBatches: (n) => `Pack ${batches(n)}`,
  countFirst: (then) => `1. Count again. 2. ${then}.`,
  countFirstHint: "The number at home is below 0. Count the packs under Stock first.",

  priceSet: "Set the price",
  priceSetSub: "Counts for all sales so far",
  priceFixOld: "Fix the old price",
  priceFixOldSub: "Changes old profit too",
  priceMuchHigher: (now, before) =>
    `${now} is much more than the last price ${before}. Is that right?`,
  priceMuchLower: (now, before) =>
    `${now} is much less than the last price ${before}. Is that right?`,
  priceAboveSale: (now, sale) =>
    `${now} is more than the pack sells for (about ${sale}). Is that right?`,
  priceSaveAnyway: "Yes, save anyway",
  priceChange: "Change the price",

  receiptPriceLabel: "Price per pack",
  receiptNewPrice: (now, before) => `New price ${now} (was ${before}).`,
  receiptFirstPrice: (now) => `Price ${now} per pack.`,
  receiptLeft: (left) => `You keep ${left} per pack.`,
  receiptPriceSaved: (now) => `New price ${now} from today.`,
  receiptPriceFailed: (reason) => `The packs are saved, but the price was not saved. ${reason}`,
  receiptPriceFailedTitle: "The price was not saved",
  receiptPriceInvalid: "Write the price in kronor, like 112.50.",

  ordered: "Ordered",
  boughtHere: "It arrived",
  orderedHint: "Comes in about 7 days. The list stops asking for them.",
  orderedSave: "Save as ordered",
  orderedToast: (n, title) => `Ordered: ${packs(n)} ${title}.`,
  wayTitle: "On the way",
  wayLine: (n, when) => `On the way: ${packs(n)}, expected ${when}`,
  wayLineLate: (n, when) => `On the way: ${packs(n)}, was expected ${when}`,
  wayToday: "today",
  weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  arrived: "It arrived",
  arrivedHint: "How many packs came, and what did they cost?",
  arrivedSave: "Add to stock",
  gotFewer: (planned, got) =>
    `You planned ${f.int(planned)}, got ${f.int(got)}. We will ask you to buy ${f.int(planned - got)} more.`,
  notSavedTitle: "Not saved",

  toMystery: (n, into) => `${f.int(n)} of them go into ${into}.`,
  toMysteryAll: (into) => `All of them go into ${into}.`,
  mysteryPacks: "mystery packs",
};

/**
 * Swedish messages from this track's server actions and database functions, in English:
 * the exact Swedish text → the English text. `t.serverError(message)` looks here after the
 * shared table in ../en.ts, so the track never edits that table. Same simple words as above.
 */
export const serverErrors: Record<string, string> = {};
