/**
 * Round 2, track T2: English texts for the to-do list, the start page and the phone shell (the simple view).
 *
 * Same keys as ./t2.sv.ts (the type R2T2 and i18n.test.ts enforce it). Simple words for
 * someone who is not technical: never Awish, VMB, queue, margin, contract or supplier.
 * Small words such as "3 packs" and "at Kontoret": import from "../words.en".
 */

import type { R2T2 } from "./t2.sv";

export const t2: R2T2 = {};

/**
 * Swedish messages from this track's server actions and database functions, in English:
 * the exact Swedish text → the English text. `t.serverError(message)` looks here after the
 * shared table in ../en.ts, so the track never edits that table. Same simple words as above.
 */
export const serverErrors: Record<string, string> = {};
