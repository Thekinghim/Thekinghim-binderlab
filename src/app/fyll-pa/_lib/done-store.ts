/**
 * Bekräftelsen efter Klar ("Klart! 12 pack påfyllda", med Ångra) och Ta med-listans läge
 * hålls utanför FillApp (./scoped-store.ts).
 *
 * Felet som rättades: efter Klar hämtades automatens adress om (router.refresh) samtidigt
 * som adressen byttes tillbaka till listan. Next svarade ibland med att ladda om hela sidan,
 * och bekräftelsen, som låg i useState, försvann innan den syntes. Nu överlever den både en
 * ommontering och en omladdning (flikens sessionStorage), i 30 minuter: lika länge som
 * Ångra går att använda.
 */

import { createScopedStore, useScopedStore } from "./scoped-store";

/** Senaste Klar: bekräftelsen överst med Ångra. */
export interface Done {
  readonly packs: number;
  readonly left: string;
  readonly offline: boolean;
  readonly clientIds: readonly string[];
}

/** Så länge finns bekräftelsen kvar (Ångra gäller i 30 minuter). */
export const DONE_MAX_AGE_MS = 30 * 60_000;

export const doneStore = createScopedStore<Done>({
  key: "binderlab:fyll-klar",
  maxAgeMs: DONE_MAX_AGE_MS,
});

/** Bekräftelsen för personen och en setter, som useState men utanför komponenten. */
export function useDone(scope: string) {
  return useScopedStore(doneStore, scope);
}

/**
 * Ta med-listan är öppen, med valda automater (null = de som behöver pack) och lagret man tar
 * från (null = det föreslagna). Överlever en ommontering: Uppdatera nollar inte valet.
 */
export interface BringState {
  readonly chosen: readonly string[] | null;
  readonly placeId: string | null;
}

export const bringStore = createScopedStore<BringState>();

/** Ta med-listans läge för personen och en setter (null = stängd). */
export function useBring(scope: string) {
  return useScopedStore(bringStore, scope);
}
