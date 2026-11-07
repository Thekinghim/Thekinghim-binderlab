/**
 * När det schemalagda jobbet kör dagens kontroll: från kl. 05 lokal tid, en gång per
 * kalenderdag i organisationens tidszon. pg_cron anropar 03:37 och 04:37 UTC; en av dem
 * är 05:37 svensk tid både sommar- och vintertid. Rent.
 */

import { businessDateAt, localParts } from "@/analytics/todos/time";

/** Första timmen (lokal tid) då dagens kontroll körs. */
export const SELF_CHECK_HOUR = 5;

export function selfCheckDue(
  now: Date,
  timeZone: string,
  lastScheduledAt: Date | null,
): { due: boolean; reason?: "not_yet" | "already_ran" } {
  const hour = Number(localParts(now.getTime(), timeZone).time.slice(0, 2));
  if (hour < SELF_CHECK_HOUR) return { due: false, reason: "not_yet" };
  if (
    lastScheduledAt &&
    businessDateAt(lastScheduledAt, timeZone) === businessDateAt(now, timeZone)
  ) {
    return { due: false, reason: "already_ran" };
  }
  return { due: true };
}
