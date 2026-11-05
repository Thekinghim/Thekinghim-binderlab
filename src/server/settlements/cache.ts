/**
 * Obetalda avräkningar (./queries.ts) sparade en kort stund mellan förfrågningar.
 *
 * Avräkningen räknas om NU med hela rapportberäkningen (./live.ts), och Att göra (menyns
 * räknare, Hem och Att göra) behöver den på varje sidladdning. Resultatet sparas därför
 * per organisation (och användare och roll, så att inget delas mellan användare) i
 * UNPAID_SETTLEMENTS_SECONDS, med taggen unpaidSettlementsTag(org).
 *
 * Räknaren ska stämma direkt efter en ändring: åtgärderna som ändrar order, testköp,
 * inköpspriser, avtal och avräkningar rensar taggen (invalidateUnpaidSettlements, via
 * revalidateSettlementData i src/server/data/core), och Awish-synken gör det när nya order
 * kommit. revalidateAppData (revalidatePath för layouten) rensar den också.
 */

import "server-only";

import { revalidateTag, unstable_cache, updateTag } from "next/cache";

import type { SettlementRef } from "@/analytics/todos";

/** Sekunder som de obetalda avräkningarna får vara gamla när inget har ändrats. */
export const UNPAID_SETTLEMENTS_SECONDS = 120;

/** Taggen för organisationens sparade obetalda avräkningar. */
export function unpaidSettlementsTag(organizationId: string): string {
  return `unpaid-settlements:${organizationId}`;
}

export interface UnpaidSettlementsKey {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
}

/**
 * `load` högst en gång per UNPAID_SETTLEMENTS_SECONDS för nyckeln, eller tills taggen
 * rensas. `tags`: fler taggar att spara under (t.ex. appDataTag). Bara i Next (sidor och
 * åtgärder); utanför Next anropar man queryUnpaidSettlements direkt.
 */
export function cachedUnpaidSettlements(
  key: UnpaidSettlementsKey,
  load: () => Promise<SettlementRef[]>,
  tags: readonly string[] = [],
): Promise<SettlementRef[]> {
  return unstable_cache(load, ["unpaid-settlements", key.organizationId, key.userId, key.role], {
    revalidate: UNPAID_SETTLEMENTS_SECONDS,
    tags: [unpaidSettlementsTag(key.organizationId), ...tags],
  })();
}

/**
 * Rensar organisationens sparade obetalda avräkningar: nästa sidladdning räknar om dem.
 * I en server action med updateTag (nästa visning väntar på nya siffror), annars (Route
 * Handler, cron) med revalidateTag utan gammalt innehåll. Utanför Next (tester, skript)
 * finns inget sparat och inget att rensa.
 */
export function invalidateUnpaidSettlements(organizationId: string): void {
  const tag = unpaidSettlementsTag(organizationId);
  try {
    updateTag(tag);
    return;
  } catch {
    // Inte i en server action.
  }
  try {
    revalidateTag(tag, { expire: 0 });
  } catch {
    // Inte i Next.
  }
}
