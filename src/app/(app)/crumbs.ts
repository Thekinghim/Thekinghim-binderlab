/**
 * Brödsmulorna i toppbaren för appens sidor: organisationen, huvudfliken, underfliken och,
 * för undersidor, undersidans namn ("Binderlab / Automater / Drift / Påfyllning"). Heter
 * underfliken som huvudfliken skrivs den en gång. Ren funktion, testas i crumbs.test.ts.
 */

import { activeSubTab, routeById } from "@/components/shell/nav";

/** Undersidor med eget namn. Dynamiska delar ([id]) skrivs som `*`. */
const SUBPAGES: ReadonlyArray<readonly [pattern: string, label: string]> = [
  ["/installningar/anvandare", "Användare"],
  ["/installningar/kontroll", "Kontroll"],
  ["/automater/enhetsekonomi", "Enhetsekonomi"],
  ["/automater/*", "Automat"],
  ["/butiker/ny", "Ny butik"],
  ["/butiker/*", "Butik"],
  ["/datakallor/fortnox", "Fortnox"],
  ["/datakallor/importer/*", "Import"],
  ["/drift/automat/*", "Automat"],
  ["/drift/besok", "Besök"],
  ["/drift/larm", "Notiser"],
  ["/drift/pafyllning", "Påfyllning"],
  ["/expansion/saljunderlag", "Säljunderlag"],
  ["/vart-lager/inventering", "Inventering"],
  ["/inkorg/nytt", "Nytt ärende"],
  ["/inkorg/*", "Ärende"],
];

/** Sidor utanför menyn. */
const STANDALONE: Readonly<Record<string, string>> = {
  "/kom-igang": "Kom igång",
  "/sok": "Sök",
  "/veckan": "Veckan",
};

function matches(pattern: string, path: string): boolean {
  const a = pattern.split("/");
  const b = path.split("/");
  return a.length === b.length && a.every((part, i) => part === "*" || part === b[i]);
}

/** Undersidans namn, eller null för menyns egna sidor. */
export function subpageLabel(pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return SUBPAGES.find(([pattern]) => matches(pattern, path))?.[1] ?? null;
}

/** Hela raden: organisationen, huvudfliken, underfliken och undersidan. `view`: sidans ?vy=. */
export function crumbsFor(
  pathname: string | null,
  orgName: string | undefined,
  view?: string | null,
): string[] {
  const path = pathname ?? "/";
  const hit = activeSubTab(path, view);
  if (!hit) {
    const page = STANDALONE[path.replace(/\/+$/, "")] ?? "Binderlab";
    return [orgName, page].filter((c): c is string => !!c);
  }
  const main = hit.section.label;
  const tab = hit.tab.label === main ? null : hit.tab.label;
  // /automater/svinn är underfliken Svinn själv (vyn som sökväg), ingen undersida.
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const isView = hit.tab.view && clean === `${routeById(hit.tab.route).href}/${hit.tab.view}`;
  const sub = isView ? null : subpageLabel(path);
  return [orgName, main, tab, sub].filter((c): c is string => !!c);
}
