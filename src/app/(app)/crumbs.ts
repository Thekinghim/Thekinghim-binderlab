/**
 * Brödsmulorna i toppbaren för appens sidor: organisationen, menyns sida och, för
 * undersidor, undersidans namn ("Binderlab / Inställningar / Användare"). Skalet visar
 * annars bara organisationen och menyns sida. Ren funktion, testas i crumbs.test.ts.
 */

import { activeRouteId, routeById } from "@/components/shell/nav";

/** Undersidor med eget namn. Dynamiska delar ([id]) skrivs som `*`. */
const SUBPAGES: ReadonlyArray<readonly [pattern: string, label: string]> = [
  ["/installningar/anvandare", "Användare"],
  ["/automater/enhetsekonomi", "Enhetsekonomi"],
  ["/automater/*", "Automat"],
  ["/butiker/*", "Butik"],
  ["/datakallor/importer/*", "Import"],
  ["/drift/automat/*", "Automat"],
  ["/drift/besok", "Besöksplan"],
  ["/drift/larm", "Larminställningar"],
  ["/drift/pafyllning", "Påfyllning"],
  ["/expansion/saljunderlag", "Säljunderlag"],
  ["/inkorg/nytt", "Nytt ärende"],
  ["/inkorg/*", "Ärende"],
];

/** Sidor utanför menyn. */
const STANDALONE: Readonly<Record<string, string>> = {
  "/kom-igang": "Kom igång",
  "/sok": "Sök",
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

/** Hela raden: organisationen, sidan och undersidan. */
export function crumbsFor(pathname: string | null, orgName: string | undefined): string[] {
  const path = pathname ?? "/";
  const id = activeRouteId(path);
  const page = id ? routeById(id).label : (STANDALONE[path.replace(/\/+$/, "")] ?? "Binderlab");
  const sub = id ? subpageLabel(path) : null;
  return [orgName, page, sub].filter((c): c is string => !!c);
}
