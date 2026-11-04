/**
 * Drifts undersidor och länken till larmlistan. Rent och klientsäkert (drift-nav.tsx och
 * Status använder samma), testas i nav.test.ts.
 */

import { formatInt } from "@/lib/format";

import { plural } from "./display";

/** Undersidorna i Drift. Notiser är inställningarna för larmen; själva larmen står på Status. */
export const DRIFT_TABS = [
  { href: "/drift", label: "Status" },
  { href: "/drift/besok", label: "Besök" },
  { href: "/drift/pafyllning", label: "Påfyllning" },
  { href: "/drift/larm", label: "Notiser" },
] as const;

/** Larmlistan på Status. */
export const ALERT_LIST_HREF = "/drift#larm-sektion";

/** Är undersidan aktiv? Automatsidorna (/drift/automat/…) hör till Status. */
export function driftTabActive(href: string, pathname: string): boolean {
  return href === "/drift"
    ? pathname === "/drift" || pathname.startsWith("/drift/automat")
    : pathname === href || pathname.startsWith(`${href}/`);
}

/** "5 öppna larm, 2 kritiska" som länk till listan, eller null utan öppna larm. */
export function alertCountLink(
  open: number,
  critical: number,
): { label: string; href: string } | null {
  if (open <= 0) return null;
  const crit =
    critical > 0 ? `, ${formatInt(critical)} ${critical === 1 ? "kritiskt" : "kritiska"}` : "";
  return { label: `${plural(open, "öppet larm", "öppna larm")}${crit}`, href: ALERT_LIST_HREF };
}
