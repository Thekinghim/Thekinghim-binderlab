/**
 * Länkar från Hem till underlaget.
 *
 * Reglerna i @/analytics bygger länkar med sina egna parametrar (?fran=&till=) och till
 * vyer som ännu inte är egna sidor (/forsaljning, /titlar/<id>). Här översätts de till
 * panelens rutter och skalets parametrar (?from=&to=, ?butik=, ?automat=), så att
 * mottagarsidan visar samma period och samma filter. Ren funktion, utan Next.
 */

import type { DataScope } from "@/server/data/core/types";

const BASE = "http://binderlab.invalid";

/** Lägger till skalets filter (butik/automat) om länken inte redan har ett eget. */
function withScope(params: URLSearchParams, scope: DataScope | null): void {
  if (!scope) return;
  if (scope.storeId && !params.has("butik")) params.set("butik", scope.storeId);
  if (scope.machineId && !params.has("automat")) params.set("automat", scope.machineId);
}

/** ?fran=&till= → ?from=&to= (skalets periodparametrar). */
function renamePeriodParams(params: URLSearchParams): void {
  const from = params.get("fran");
  const to = params.get("till");
  params.delete("fran");
  params.delete("till");
  if (from) {
    params.delete("period");
    params.set("from", from);
    params.set("to", to ?? from);
  }
}

function build(path: string, params: URLSearchParams): string {
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

/**
 * Länken från en iakttagelse eller en punkt i Att göra, som en adress i panelen.
 * Okända eller externa adresser blir "/" (aldrig en länk ut ur appen).
 */
export function appHref(link: string, scope: DataScope | null = null): string {
  let url: URL;
  try {
    url = new URL(link, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  const params = new URLSearchParams(url.search);
  const path = url.pathname;

  // Försäljning per dag eller veckodag: Lönsamhet per dag för samma period.
  if (path === "/forsaljning") {
    renamePeriodParams(params);
    const view = params.get("vy");
    params.delete("vy");
    params.set("grupp", view === "veckodag" ? "veckodag" : "dag");
    withScope(params, scope);
    return build("/lonsamhet", params);
  }

  // En titel: Lönsamhet per titel, med titeln vald.
  const title = /^\/titlar\/([^/]+)$/.exec(path);
  if (title?.[1]) {
    renamePeriodParams(params);
    params.set("grupp", "titel");
    params.set("titel", decodeURIComponent(title[1]));
    withScope(params, scope);
    return build("/lonsamhet", params);
  }

  if (path === "/lonsamhet" || path.startsWith("/automater/")) {
    renamePeriodParams(params);
    if (path === "/lonsamhet") withScope(params, scope);
    return build(path, params);
  }

  return build(path, params);
}

/** Skalets parametrar (period och filter) för länkar till andra sidor med samma urval. */
export function carriedParams(
  sp: Record<string, string | string[] | undefined>,
  extra: Record<string, string> = {},
): string {
  const out = new URLSearchParams();
  for (const key of ["period", "from", "to", "butik", "automat"]) {
    const v = sp[key];
    const value = Array.isArray(v) ? v[0] : v;
    if (value) out.set(key, value);
  }
  for (const [k, v] of Object.entries(extra)) out.set(k, v);
  const q = out.toString();
  return q ? `?${q}` : "";
}
