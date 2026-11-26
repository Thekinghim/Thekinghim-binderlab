/**
 * Vart den som just loggat in skickas. Den som är medlem i en organisation går dit den
 * skulle (`next`, annars Hem). Den som BARA är påfyllare i butiken (machine_refiller) går
 * direkt till /pafyll, och den som BARA är butiksanvändare (store) direkt till /portal.
 *
 * Utan det gick de via / och appens layout, som läste sammanhanget, kastade (sidan bakom
 * kräver ett medlemskap) och skickade vidare: två extra sidbyten och fel i loggen. Layouterna
 * skickar ändå vidare som förut (bokmärken, hemskärmen); det här tar bara bort omvägen.
 * Behörigheten hänger inte på det här: RLS och sidornas kontroller gäller som vanligt.
 */

import "server-only";

import { listOrganizationsFor, withUserDbFor } from "@/server/access";
import { queryPortalStores } from "@/server/portal/queries";
import { getSessionUser } from "@/server/session";
import { queryStaffMachines } from "@/server/staff/session";

import { landingPath } from "./landing-path";

/**
 * Läser vad den inloggade är och ger sökvägen. Går något fel (eller syns sessionen inte än)
 * blir det `next`: layouterna skickar då vidare som förut.
 */
export async function landingAfterLogin(next: string): Promise<string> {
  try {
    const user = await getSessionUser();
    if (!user) return next;
    if ((await listOrganizationsFor(user)).length > 0) return next;
    const staff = (await queryStaffMachines(user)).length > 0;
    const store = staff ? false : (await withUserDbFor(user, queryPortalStores)).length > 0;
    return landingPath(next, { member: false, staff, store });
  } catch (error) {
    console.error(
      "[logga-in] Startsidan kunde inte väljas:",
      error instanceof Error ? error.name : "fel",
    );
    return next;
  }
}
