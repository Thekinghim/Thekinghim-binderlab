/**
 * "Vem pengarna är till" på Pengar: periodens försäljning delad som en utbetalning från
 * Nayax som täcker exakt periodens dagar (src/server/data/v2/analytics/split-model.ts).
 * Samma underlag som Utbetalningar (loadAllocationInputsTx), men utan tidigare
 * utbetalningar: inga skulder, underskott eller rättelser förs in, och inget sparas.
 *
 * Partnerns andel visar vårt inköp: bara ägare och admin (som Utbetalningar). Allt körs som
 * användaren under RLS.
 */

import "server-only";

import { eq } from "drizzle-orm";

import * as s from "@/db/schema";
import type { Period } from "@/domain";
import { storeNameLabel } from "@/lib/format";
import { withUserDbFor } from "@/server/access";
import { requireViewerRole, type Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import { splitView, type SplitView } from "@/server/data/v2/analytics/split-model";

import { loadAllocationInputsTx, loadOrgPayoutContextTx, type PriorState } from "./inputs";

const NO_PRIOR: PriorState = {
  allocated: new Map(),
  covered: [],
  vatCarryOutOre: 0,
  partnerCarryOutOre: 0,
  partnerAdjustOre: 0,
  vatAdjustOre: 0,
};

/** Fördelningen för perioden (se filhuvudet). */
export async function loadPeriodSplitFor(
  viewer: Viewer,
  period: Period,
  now: Date,
): Promise<SplitView> {
  const orgId = viewer.organization.id;
  // Rollen är redan läst ur databasen i förfrågan (verifiedViewer), annars läses den här.
  await requireViewerRole(viewer, OPERATOR_ROLES);
  return withUserDbFor(viewer.user, async (tx) => {
    const ctx = await loadOrgPayoutContextTx(tx, orgId);
    const [inputs, stores, owners] = await Promise.all([
      loadAllocationInputsTx(
        tx,
        ctx,
        { id: "period", periodStart: period.start, periodEnd: period.end, amountOre: 0 },
        NO_PRIOR,
        now,
      ),
      tx
        .select({ id: s.stores.id, name: s.stores.name, city: s.stores.city })
        .from(s.stores)
        .where(eq(s.stores.organizationId, orgId)),
      tx
        .select({ id: s.storeOwners.id, legalName: s.storeOwners.legalName })
        .from(s.storeOwners)
        .where(eq(s.storeOwners.organizationId, orgId)),
    ]);
    const split = inputs.split;
    const gross = split.slices.reduce((a, x) => a + x.grossOre, 0);
    const refunds = split.slices.reduce((a, x) => a + x.refundsOre, 0);
    // Det vi väntar från Nayax = försäljning − kortavgift (− återbetalningar i Nayax).
    const feesOre = gross - split.expectedNetOre - (ctx.refundsVia === "nayax" ? refunds : 0);
    const storeName = new Map(stores.map((r) => [r.id, storeNameLabel(r.name, r.city)]));
    const ownerName = new Map(owners.map((r) => [r.id, r.legalName]));
    const partner = [...ctx.partners].reverse().find((p) => p.validFrom <= period.end) ?? null;
    return splitView({
      split,
      feesOre,
      refundsVia: ctx.refundsVia,
      extraWarnings: inputs.extraWarnings,
      storeName: (id) => storeName.get(id) ?? "Butik",
      ownerName: (id) => ownerName.get(id) ?? "Bolag",
      partnerName: partner?.partnerName ?? null,
    });
  });
}
