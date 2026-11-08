/**
 * Enkel vy (memberships.view_mode = 'simple'): en MYCKET nerskalad app för den som inte är
 * teknisk. Bara tre saker: Fyll på, Försäljning och Mystery packs, plus språk och Logga ut.
 * Ren data och rena funktioner: samma regler i servern (omdirigeringen i
 * @/server/data/core) och i skalet (flikarna, SimpleShell).
 *
 * Vyn är oberoende av rollen: en delägare behåller ägarrollen i datan men ser bara det här.
 * Flikarna följer ändå rollen (påfyllaren ser ingen försäljning, läsaren fyller inte på).
 */

import type { IconName } from "@/components/ui/icon";
import type { MemberRole } from "@/db/schema";

/** Proxyn skickar sökvägen till servern i den här headern (skrivs alltid över). */
export const PATHNAME_HEADER = "x-bl-pathname";

/** Försäljning: startsidan "/" i den enkla vyn (Hem visar den). Samma skärm på /forsaljning. */
export const SALES_HREF = "/";
export const SALES_PAGE_HREF = "/forsaljning";
export const REFILL_HREF = "/fyll-pa";
export const MYSTERY_HREF = "/vart-lager/mystery";

export type SimpleTabId = "refill" | "sales" | "mystery";

export interface SimpleTab {
  readonly id: SimpleTabId;
  readonly href: string;
  readonly icon: IconName;
  readonly roles: readonly MemberRole[];
}

/** I den här ordningen i bottenraden: det viktigaste först. */
export const SIMPLE_TABS: readonly SimpleTab[] = [
  { id: "refill", href: REFILL_HREF, icon: "machine", roles: ["owner", "admin", "refiller"] },
  { id: "sales", href: SALES_HREF, icon: "sales", roles: ["owner", "admin", "viewer"] },
  {
    id: "mystery",
    href: MYSTERY_HREF,
    icon: "inventory",
    roles: ["owner", "admin", "refiller", "viewer"],
  },
];

export function simpleTabsFor(role: MemberRole): SimpleTab[] {
  return SIMPLE_TABS.filter((t) => t.roles.includes(role));
}

/** Startsidan i den enkla vyn: Försäljning, annars första fliken rollen har. */
export function simpleHomeFor(role: MemberRole): string {
  const tabs = simpleTabsFor(role);
  return (tabs.find((t) => t.id === "sales") ?? tabs[0])?.href ?? MYSTERY_HREF;
}

function isPathOrBelow(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Sökvägar den enkla vyn får öppna. Allt annat i appen skickas till startsidan i den
 * enkla vyn. Sidorna utan inloggning (inloggning, inbjudan, butiksrapporter, signering)
 * och statiska filer (service workern, manifestet, ikoner) rör inte appens laddare och
 * påverkas inte.
 */
const ALLOWED: readonly string[] = [
  SALES_PAGE_HREF,
  REFILL_HREF,
  MYSTERY_HREF,
  // Språk och Logga ut är server actions på sidan man står på; inloggningen och
  // inbjudan behövs om personen loggar ut eller tar emot en ny inbjudan.
  "/logga-in",
  "/inbjudan",
];

/** Får den enkla vyn öppna sökvägen? Okända tecken och `..` släpps aldrig igenom. */
export function simpleViewAllows(pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname.includes("..") || pathname.includes("\\")) {
    return false;
  }
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  // Startsidan (Försäljning) bara exakt "/".
  if (path === "/") return true;
  return ALLOWED.some((base) => isPathOrBelow(path, base));
}
