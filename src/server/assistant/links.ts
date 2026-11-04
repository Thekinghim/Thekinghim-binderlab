/**
 * Länkarna i assistentens underlag (verktygens `links` och knapparna från foresla_knapp)
 * som adresser som finns. Reglerna i @/analytics bygger länkar till vyer som inte är egna
 * sidor (/forsaljning, /titlar/<id>); de översätts som på Hem (appHref). Några verktyg
 * länkade förr till /ekonomi/bokforing, som aldrig funnits (sidan är /ekonomi?vy=bokforing):
 * gamla sparade svar visar därför också rätt länk. Ren modul, används av loopen och av
 * underlaget på /assistent.
 */

import { appHref } from "@/app/(app)/_hem/links";

/** Gamla adresser som inte finns → sidan de menade. */
const LEGACY: Readonly<Record<string, string>> = {
  "/ekonomi/bokforing": "/ekonomi?vy=bokforing#bokforing",
};

/** Adressen att länka till. Okända eller externa adresser blir "/" (appHref). */
export function toolHref(href: string): string {
  const path = href.split(/[?#]/, 1)[0] ?? "";
  return LEGACY[path] ?? appHref(href);
}

/** Samma lista med giltiga adresser. */
export function withToolHrefs<T extends { readonly href: string }>(links: readonly T[]): T[] {
  return links.map((l) => ({ ...l, href: toolHref(l.href) }));
}
