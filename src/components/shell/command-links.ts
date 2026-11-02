/**
 * Länkar från kommandopaletten: vilka av skalets parametrar som följer med och
 * automatens namn som i resten av panelen. Rent och testbart (command-links.test.ts).
 */

import type { CarryMode } from "@/server/search/types";

import { FROM_PARAM, MACHINE_PARAM, PERIOD_PARAM, STORE_PARAM, TO_PARAM } from "./period-state";

const CARRIED: Record<CarryMode, readonly string[]> = {
  all: [PERIOD_PARAM, FROM_PARAM, TO_PARAM, STORE_PARAM, MACHINE_PARAM],
  period: [PERIOD_PARAM, FROM_PARAM, TO_PARAM],
  none: [],
};

/**
 * Länken med skalets parametrar som följer med enligt `carry` ("all": period och
 * filter, "period": bara perioden, "none": inget). Länkens egna parametrar vinner,
 * och ett ankare (#ny-rapport) behålls.
 */
export function withCarried(
  href: string,
  carry: CarryMode,
  current: { get(name: string): string | null },
): string {
  const url = new URL(href, "http://binderlab.invalid");
  for (const name of CARRIED[carry]) {
    const v = current.get(name);
    if (v !== null && v !== "" && !url.searchParams.has(name)) url.searchParams.set(name, v);
  }
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`;
}

/** Automatens namn som i resten av panelen: "BL-002 Mobilia". */
export function machineLabel(m: { name: string; code?: string }): string {
  if (!m.code || m.name.startsWith(m.code)) return m.name;
  return `${m.code} ${m.name}`;
}
