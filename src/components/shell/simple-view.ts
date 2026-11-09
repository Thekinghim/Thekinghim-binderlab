/**
 * Enkel vy (memberships.view_mode = 'simple'): en MYCKET nerskalad app för den som inte är
 * teknisk. Bara fyra flikar: Fyll på, Försäljning (med vinst per produkt), Lager (lagret,
 * inköpslistan och inköpspriserna) och Mystery packs, plus språk och Logga ut.
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
/** Lager: tre underflikar på samma sökvägar som i hela appen (bara exakt de sökvägarna). */
export const STOCK_HREF = "/vart-lager";
export const BUY_LIST_HREF = "/prognos";
export const PRICES_HREF = "/inkopspriser";

export type SimpleTabId = "refill" | "sales" | "stock" | "mystery";

export interface SimpleTab {
  readonly id: SimpleTabId;
  readonly href: string;
  readonly icon: IconName;
  readonly roles: readonly MemberRole[];
  /** Fler sökvägar (exakt) där fliken är markerad (Lagers underflikar). */
  readonly also?: readonly string[];
}

/** Lagrets underflikar i den här ordningen: Lager, Inköpslista, Inköpspriser. */
export type StockSubTabId = "stock" | "buy" | "prices";
export const STOCK_SUBTABS: readonly { readonly id: StockSubTabId; readonly href: string }[] = [
  { id: "stock", href: STOCK_HREF },
  { id: "buy", href: BUY_LIST_HREF },
  { id: "prices", href: PRICES_HREF },
];

/** I den här ordningen i bottenraden: det viktigaste först. */
export const SIMPLE_TABS: readonly SimpleTab[] = [
  { id: "refill", href: REFILL_HREF, icon: "machine", roles: ["owner", "admin", "refiller"] },
  { id: "sales", href: SALES_HREF, icon: "sales", roles: ["owner", "admin", "viewer"] },
  {
    id: "stock",
    href: STOCK_HREF,
    icon: "stock",
    roles: ["owner", "admin", "viewer"],
    also: [BUY_LIST_HREF, PRICES_HREF],
  },
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

/** Utan avslutande snedstreck ("/vart-lager/" är "/vart-lager"). */
function trimmed(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

/**
 * Är fliken markerad på sökvägen? Lager bara på exakt sina tre sökvägar (Mystery ligger
 * under /vart-lager/mystery och är en egen flik), de andra även på sidorna under.
 */
export function simpleTabActive(tab: SimpleTab, pathname: string): boolean {
  const path = trimmed(pathname);
  if (tab.also) return path === tab.href || tab.also.includes(path);
  return isPathOrBelow(path, tab.href);
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

/**
 * Bara exakt de här sökvägarna, inget under dem: Lager, Inköpslistan och Inköpspriserna
 * visar den enkla vyns egna skärmar där. Flytta, Ny produkt och resten av hela appens
 * lagersidor stoppas.
 */
const ALLOWED_EXACT: readonly string[] = [STOCK_HREF, BUY_LIST_HREF, PRICES_HREF];

/** Får den enkla vyn öppna sökvägen? Okända tecken och `..` släpps aldrig igenom. */
export function simpleViewAllows(pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname.includes("..") || pathname.includes("\\")) {
    return false;
  }
  const path = trimmed(pathname);
  // Startsidan (Försäljning) bara exakt "/".
  if (path === "/") return true;
  if (ALLOWED_EXACT.includes(path)) return true;
  return ALLOWED.some((base) => isPathOrBelow(path, base));
}
