/**
 * Round 2, track T1: English texts for the refill app, sending counts to the machines, and mystery packs.
 *
 * Same keys as ./t1.sv.ts (the type R2T1 and i18n.test.ts enforce it). Simple words for
 * someone who is not technical: never Awish, VMB, queue, margin, contract or supplier.
 * Small words such as "3 packs" and "at Kontoret": import from "../words.en".
 */

import type { R2T1 } from "./t1.sv";

export const t1: R2T1 = {};

/**
 * Swedish messages from this track's server actions and database functions, in English:
 * the exact Swedish text → the English text. `t.serverError(message)` looks here after the
 * shared table in ../en.ts, so the track never edits that table. Same simple words as above.
 */
export const serverErrors: Record<string, string> = {};
