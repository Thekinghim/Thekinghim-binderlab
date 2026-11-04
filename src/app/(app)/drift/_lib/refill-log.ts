/**
 * Drift → Påfyllning: de senaste påfyllningarna från Fyll på (field_submissions), utan
 * ångrade. Läses som användaren med RLS: ägare, admin och läsare ser alla, påfyllaren bara
 * sina egna (policyn field_submissions_select). Ingen ekonomi. Testas i
 * test/db/drift-pafyllning-logg.test.ts.
 */

import "server-only";

import { and, desc, eq, gte, isNull } from "drizzle-orm";

import * as s from "@/db/schema";
import { addDays, type IsoDate } from "@/domain";
import { withUserDbFor, type SessionUser } from "@/server/access";

import type { RefillLogRow } from "./refill-log-view";

/** Dagar bakåt i loggen (i dag och veckan före). */
export const REFILL_LOG_DAYS = 7;

export async function loadRefillLogFor(
  user: SessionUser,
  args: { organizationId: string; today: IsoDate },
): Promise<RefillLogRow[]> {
  const orgId = args.organizationId;
  // En dag extra bakåt i UTC: dagen räknas sedan i organisationens tidszon (refillLogView).
  const since = new Date(`${addDays(args.today, -REFILL_LOG_DAYS - 1)}T00:00:00Z`);
  return withUserDbFor(user, async (tx) => {
    const list = await tx
      .select({
        clientId: s.fieldSubmissions.clientId,
        quantity: s.fieldSubmissions.quantity,
        occurredAt: s.fieldSubmissions.occurredAt,
        submittedBy: s.fieldSubmissions.submittedBy,
        machineCode: s.machines.code,
        machineName: s.machines.name,
        titleName: s.titles.name,
        by: s.profiles.displayName,
      })
      .from(s.fieldSubmissions)
      .innerJoin(
        s.machines,
        and(
          eq(s.machines.organizationId, s.fieldSubmissions.organizationId),
          eq(s.machines.id, s.fieldSubmissions.machineId),
        ),
      )
      .innerJoin(
        s.titles,
        and(
          eq(s.titles.organizationId, s.fieldSubmissions.organizationId),
          eq(s.titles.id, s.fieldSubmissions.titleId),
        ),
      )
      .leftJoin(
        s.profiles,
        and(
          eq(s.profiles.organizationId, s.fieldSubmissions.organizationId),
          eq(s.profiles.userId, s.fieldSubmissions.submittedBy),
        ),
      )
      .where(
        and(
          eq(s.fieldSubmissions.organizationId, orgId),
          eq(s.fieldSubmissions.kind, "refill"),
          isNull(s.fieldSubmissions.undoneAt),
          gte(s.fieldSubmissions.occurredAt, since),
        ),
      )
      .orderBy(desc(s.fieldSubmissions.occurredAt))
      .limit(300);
    return list.map((r) => ({
      clientId: r.clientId,
      machineCode: r.machineCode,
      machineName: r.machineName,
      titleName: r.titleName,
      quantity: r.quantity,
      occurredAt: r.occurredAt.toISOString(),
      // Kollegornas namn syns bara för den som får läsa deras profil (RLS); annars "du".
      by: r.by ?? (r.submittedBy === user.userId ? "Du" : null),
    }));
  });
}
