import { unstable_rethrow } from "next/navigation";

import type { ActionResult } from "@/server/auth/flows";

/** Texten när servern inte gick att nå (ingen täckning, flygplansläge, servern nere). */
export const NO_CONTACT = "Ingen kontakt. Inget har ändrats. Försök igen.";

/**
 * Kör en serveråtgärd och gör ett kastat fel (ingen täckning: fetch misslyckas) till ett vanligt
 * felsvar. Utan det bubblade felet ur transitionen och hela Rutt byttes mot felsidan.
 */
export async function reach<T>(call: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await call();
  } catch (error) {
    // Nexts egna (omdirigering till inloggningen m.m.) ska fram som vanligt.
    unstable_rethrow(error);
    console.error("[rutt] Åtgärden nådde inte servern:", error);
    return { ok: false, error: NO_CONTACT };
  }
}
