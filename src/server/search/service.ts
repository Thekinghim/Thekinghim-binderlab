/**
 * Sökningen för kommandopaletten, bunden till en användare och organisation.
 *
 * Rollen läses ur databasen (requireRoleFor, under RLS) och allt läses sedan i EN
 * transaktion som användaren (withUserDbFor, RLS). Order söks bara för roller som ser
 * ekonomi; påfyllaren får titlar, automater och butiker utan belopp. Funktionerna tar
 * en Viewer så att de kan testas utan Next (test/db/sok-search.test.ts); rutten
 * GET /sok använder varianterna i ./index.
 */

import "server-only";

import type { Tx } from "@/db/client";
import type { MemberRole } from "@/db/schema";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { todayIn, toIsoDate } from "@/components/shell/period-state";
import {
  queryMachines,
  queryPlacements,
  queryStores,
  queryTitles,
} from "@/server/data/core/queries";
import type { Viewer } from "@/server/data/core/loaders";
import { ALL_ROLES, canSeeEconomy, OPERATOR_ROLES } from "@/server/data/core/types";

import {
  cleanSearch,
  looksLikeOrderNumber,
  masterGroups,
  orderGroup,
  orderGroups,
  orderTerms,
  pricePick,
  refillPick,
  type SearchMaster,
} from "./model";
import { queryAliases, queryMachineStock, queryPricedTitles, querySearchOrders } from "./queries";
import { HITS_PER_GROUP, type PickList, type PickResponse, type SearchResponse } from "./types";

/** Roller som registrerar påfyllning (som Lager). */
const REFILL_ROLES = ["owner", "admin", "refiller"] as const satisfies readonly MemberRole[];

async function loadSearchMaster(tx: Tx, orgId: string, now: Date, timeZone: string) {
  const today = toIsoDate(todayIn(now, timeZone));
  const [titles, placements, stores, aliases] = await Promise.all([
    queryTitles(tx, orgId),
    queryPlacements(tx, orgId),
    queryStores(tx, orgId),
    queryAliases(tx, orgId),
  ]);
  const machines = await queryMachines(tx, orgId, placements, today);
  const master: SearchMaster = { titles, machines, stores, aliases };
  return master;
}

/**
 * Söker i order (ordernummer, titel), titlar, automater och butiker. Tom söktext ger
 * tomt svar. Kastar AuthorizationError om användaren inte är medlem i organisationen.
 */
export async function searchFor(
  viewer: Viewer,
  rawQuery: string,
  now: Date = new Date(),
): Promise<SearchResponse> {
  const q = cleanSearch(rawQuery);
  const org = viewer.organization;
  const role = await requireRoleFor(viewer.user, org.id, ALL_ROLES);
  if (!q) return { query: q, groups: [] };

  return withUserDbFor(viewer.user, async (tx) => {
    const master = await loadSearchMaster(tx, org.id, now, org.timezone);
    const groups = masterGroups(q, master, role);

    let orders = null;
    const terms = canSeeEconomy(role) ? orderTerms(q, master) : null;
    if (terms) {
      // En rad extra avgör om länken "Alla order som matchar" behövs.
      const { exact, recent } = await querySearchOrders(
        tx,
        org.id,
        terms,
        looksLikeOrderNumber(q) ? q : null,
        HITS_PER_GROUP + 1,
      );
      orders = orderGroup({
        q,
        role,
        exact,
        recent,
        more: recent.length > HITS_PER_GROUP,
        master,
        timeZone: org.timezone,
        now,
      });
    }
    return { query: q, groups: orderGroups(q, [...groups, orders]) };
  });
}

/**
 * Listan för ett steg i paletten: titlar för påfyllning i en automat (ägare, admin,
 * påfyllare; antal pack, inga belopp) eller titlar för nytt inköpspris (ägare, admin).
 */
export async function pickListFor(
  viewer: Viewer,
  list: PickList,
  machineId: string | null,
  now: Date = new Date(),
): Promise<PickResponse> {
  const org = viewer.organization;
  const roles = list === "pafyllning" ? REFILL_ROLES : OPERATOR_ROLES;
  await requireRoleFor(viewer.user, org.id, roles);
  if (list === "pafyllning" && !machineId) return { list, groups: [] };
  return withUserDbFor(viewer.user, async (tx) => {
    const master = await loadSearchMaster(tx, org.id, now, org.timezone);
    if (list === "pafyllning") {
      const machine = master.machines.find((m) => m.id === machineId && !m.archived);
      if (!machine) return { list, groups: [] };
      const stock = await queryMachineStock(tx, org.id, machine.id);
      return { list, groups: refillPick(master.titles, stock) };
    }
    const priced = await queryPricedTitles(tx, org.id);
    return { list, groups: pricePick(master.titles, priced) };
  });
}
