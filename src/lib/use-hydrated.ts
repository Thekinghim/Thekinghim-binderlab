import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * Falskt i serverns HTML och under hydreringen, sant när komponenten lever i webbläsaren.
 * För knappar som annars skickar formuläret som en vanlig sidladdning (och tappar det
 * man skrivit) om man trycker innan sidans skript har laddats.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
