/**
 * Round 2, track T3: English texts for stock and buying (stock, buy list, purchase prices).
 *
 * Same keys as ./t3.sv.ts (the type R2T3 and i18n.test.ts enforce it). Simple words for
 * someone who is not technical: never Awish, VMB, queue, margin, contract or supplier.
 * Small words such as "3 packs" and "at Kontoret": import from "../words.en".
 */

import { batches } from "../words.en";
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
};

/**
 * Swedish messages from this track's server actions and database functions, in English:
 * the exact Swedish text → the English text. `t.serverError(message)` looks here after the
 * shared table in ../en.ts, so the track never edits that table. Same simple words as above.
 */
export const serverErrors: Record<string, string> = {};
