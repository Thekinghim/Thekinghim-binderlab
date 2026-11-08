/**
 * Enkel vy: spärren på servern. Allt utanför det tillåtna (Fyll på, Försäljning, Mystery
 * packs, se @/components/shell/simple-view) skickas till den enkla vyns startsida.
 *
 * Körs där den aktiva organisationen läses: i laddarna (@/server/data/core, loadViewer)
 * och i getActiveOrganization (@/server/session), som route handlers (sökningen,
 * assistenten, exporten, avtals- och bokföringsfiler), currentViewer och många server
 * actions använder. Alltså för varje sida, route och server action som läser data, även
 * vid navigering i webbläsaren (layouten renderas då inte om).
 *
 * Sökvägen kommer från proxyn, som alltid skriver över headern (src/proxy.ts). En server
 * action har sidans sökväg. Utan header (tester, cron, skript) görs ingenting: där finns
 * ingen sida att visa.
 */

import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { PATHNAME_HEADER, simpleHomeFor, simpleViewAllows } from "@/components/shell/simple-view";
import type { MemberRole } from "@/db/schema";

export async function guardSimpleView(
  organization: { viewMode?: "full" | "simple"; role: MemberRole } | null | undefined,
): Promise<void> {
  if (organization?.viewMode !== "simple") return;
  let pathname: string | null = null;
  try {
    pathname = (await headers()).get(PATHNAME_HEADER);
  } catch {
    return;
  }
  if (pathname !== null && !simpleViewAllows(pathname)) redirect(simpleHomeFor(organization.role));
}
