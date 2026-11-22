/**
 * Mer (G4): antalen i Driften-kortet och Kopplingar. Bara antal och status, inga belopp.
 * Varje del läses för sig; ett fel ger "–" i stället för att stoppa sidan.
 */

import "server-only";

import { count, eq } from "drizzle-orm";

import * as s from "@/db/schema";
import { withUserDbFor } from "@/server/access";
import type { AppContext, SyncInfo } from "@/server/data/core/types";
import { loadMasterData, loadSyncInfo, requireViewer } from "@/server/data/core";
import { loadRouteLimits } from "@/server/data/v2/route";
import type { RouteLimits } from "@/server/data/v2/types";

import { loadMembersPageFor } from "../../installningar/anvandare/members-data";

export interface MoreCounts {
  readonly machines: number | null;
  readonly stores: number | null;
  /** Personer i organisationen (ägare och admin ser dem). */
  readonly people: number | null;
  readonly suppliers: number | null;
  readonly route: RouteLimits | null;
  readonly sync: SyncInfo | null;
}

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    console.error(`[mer] ${label} kunde inte läsas:`, error);
    return null;
  }
}

export async function loadMoreCounts(ctx: AppContext): Promise<MoreCounts> {
  const [master, people, suppliers, route, sync] = await Promise.all([
    safe("stamdata", () => loadMasterData()),
    ctx.canEdit
      ? safe("personal", async () => {
          const v = await requireViewer();
          return (await loadMembersPageFor(v.user, v.organization.id)).members.length;
        })
      : null,
    safe("leverantörer", async () => {
      const v = await requireViewer();
      return withUserDbFor(v.user, async (tx) => {
        const [row] = await tx
          .select({ n: count() })
          .from(s.suppliers)
          .where(eq(s.suppliers.organizationId, v.organization.id));
        return row?.n ?? 0;
      });
    }),
    safe("ruttens gräns", () => loadRouteLimits()),
    safe("synk", () => loadSyncInfo()),
  ]);
  return {
    machines: master ? master.machines.filter((m) => !m.archived && !m.isExample).length : null,
    stores: master ? master.stores.filter((x) => !x.archived && !x.isExample).length : null,
    people,
    suppliers,
    route,
    sync,
  };
}
