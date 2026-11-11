/**
 * Ett litet minne utanför React för Fyll på, per person (scope = organisation och användare).
 *
 * Varför: /fyll-pa och /fyll-pa/<automat> är två rutter som visar samma FillApp, och byte
 * mellan dem görs i webbläsaren (history.pushState). Hämtas datan om medan adressen hör till
 * den andra rutten byter Next ruttens träd (FillApp monteras om) eller laddar om hela sidan,
 * och då försvinner allt i useState. Det som ska överleva (bekräftelsen efter Klar, om Ta
 * med-listan är öppen) ligger därför här: i minnet, och med `persist` också i flikens
 * sessionStorage så att det överlever en omladdning. Värdet glöms efter `maxAgeMs`, när
 * fliken stängs, och syns aldrig för en annan inloggad (annat scope).
 */

import { useCallback, useSyncExternalStore } from "react";

export interface ScopedStore<T> {
  read(scope: string): T | null;
  /** Sätter värdet för personen, eller tar bort det med null. */
  write(scope: string, value: T | null): void;
  subscribe(listener: () => void): () => void;
}

/** Det som behövs av sessionStorage (utbytbart i tester). */
export interface StoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistOptions {
  /** Nyckeln i sessionStorage. */
  readonly key: string;
  /** Så länge gäller ett sparat värde. */
  readonly maxAgeMs: number;
  /** Lagringen (standard: flikens sessionStorage). */
  readonly storage?: () => StoreStorage | null;
  readonly now?: () => number;
}

interface Saved<T> {
  readonly scope: string;
  readonly value: T;
  readonly at: number;
}

function sessionStore(): StoreStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Lagring avstängd (privat läge): värdet finns bara i minnet.
    return null;
  }
}

const none = () => null;

export function createScopedStore<T>(persist?: PersistOptions): ScopedStore<T> {
  let current: Saved<T> | null = null;
  let loaded = !persist;
  const listeners = new Set<() => void>();
  const now = persist?.now ?? Date.now;
  const storage = () => (persist ? (persist.storage ?? sessionStore)() : null);

  /** Läser det sparade värdet en gång (efter en omladdning av sidan). */
  const load = () => {
    if (loaded || !persist) return;
    loaded = true;
    try {
      const raw = storage()?.getItem(persist.key);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<Saved<T>> | null;
      if (
        saved &&
        typeof saved.scope === "string" &&
        typeof saved.at === "number" &&
        saved.value !== undefined &&
        saved.value !== null
      ) {
        current = { scope: saved.scope, value: saved.value as T, at: saved.at };
      }
    } catch {
      // Trasigt eller oläsbart: som om inget var sparat.
    }
  };

  const save = () => {
    if (!persist) return;
    try {
      const s = storage();
      if (!s) return;
      if (current === null) s.removeItem(persist.key);
      else s.setItem(persist.key, JSON.stringify(current));
    } catch {
      // Fullt eller avstängt: värdet finns kvar i minnet.
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const read = (scope: string): T | null => {
    load();
    if (current === null || current.scope !== scope) return null;
    if (persist && now() - current.at > persist.maxAgeMs) return null;
    return current.value;
  };
  const write = (scope: string, value: T | null): void => {
    load();
    // En annan persons värde tas aldrig bort av den här personens "stäng".
    if (value === null && (current === null || current.scope !== scope)) return;
    current = value === null ? null : { scope, value, at: now() };
    save();
    for (const l of [...listeners]) l();
  };
  return { read, write, subscribe };
}

/**
 * Som useState, men värdet ligger i `store` och överlever att komponenten monteras om (och,
 * med `persist`, att sidan laddas om). Settern är stabil så länge `store` och `scope` är
 * desamma. I serverns HTML och under hydreringen är värdet null.
 */
export function useScopedStore<T>(
  store: ScopedStore<T>,
  scope: string,
): readonly [T | null, (value: T | null) => void] {
  const value = useSyncExternalStore(store.subscribe, () => store.read(scope), none);
  const set = useCallback((next: T | null) => store.write(scope, next), [store, scope]);
  return [value, set] as const;
}
