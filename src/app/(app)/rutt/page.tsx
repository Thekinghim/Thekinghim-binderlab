import type { Metadata } from "next";

import { V2Page, headerDate } from "@/components/v2/shell/page";
import { requireRoute } from "@/server/data/core";
import { loadDayRoute } from "@/server/data/v2/route";

import { RouteView } from "./_components/route-view";

export const metadata: Metadata = { title: "Rutt" };

/**
 * Rutt (/rutt, V2 byggplanen 2.5): dagens stopp ur besöksplanen (samma plan som Att göra, Hem,
 * Drift och Lager) grupperade per stad i körordning, packlistan mot vårt lager med ersättare,
 * Starta rutt → Fyll på steg för steg, hoppa över / till i morgon / lägg till, kommande dagar
 * och dagens gräns.
 *
 * Alla fyra roller. Ägare, admin och påfyllare ändrar rutten; ägare och admin ändrar gränsen.
 * Belopp ("räddar", "tappar") bara för ekonomiroller: laddaren skickar dem inte till
 * påfyllaren.
 */
export default async function RoutePage() {
  const ctx = await requireRoute("rutt");
  const route = await loadDayRoute();
  const field = ctx.role === "owner" || ctx.role === "admin" || ctx.role === "refiller";
  return (
    <V2Page title="Rutt" date={headerDate(new Date(ctx.now), ctx.timeZone)}>
      <RouteView
        route={route}
        scope={`${ctx.organization.id}:${ctx.user.id}`}
        canEdit={field}
        canRefill={field}
        canEditLimits={ctx.role === "owner" || ctx.role === "admin"}
      />
    </V2Page>
  );
}
