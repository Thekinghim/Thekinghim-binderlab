"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  carriedQuery,
  describePeriod,
  parsePeriod,
  parseScope,
  withPeriod,
  withScope,
  type ParseOptions,
  type PeriodDescription,
  type PeriodSelection,
  type ResolvedPeriod,
  type Scope,
} from "./period-state";

/**
 * Klienthooks för skalets URL-tillstånd. Alla läser useSearchParams, så en
 * förrenderad sida måste ha en <Suspense> runt komponenten som anropar dem
 * (AppShell gör det för sina egna delar).
 */

const noop = () => () => {};

/**
 * "Nu" som är stabilt under hydrering: servern och första klientrenderingen
 * får samma dag (lokal tid i bolagets tidszon räknas i parsePeriod).
 */
function useNow(): Date {
  const ms = useSyncExternalStore(
    noop,
    () => Math.floor(Date.now() / 60_000) * 60_000,
    () => Math.floor(Date.now() / 60_000) * 60_000,
  );
  return useMemo(() => new Date(ms), [ms]);
}

function useReplaceQuery() {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(
    (next: URLSearchParams) => {
      const q = next.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
}

export type UsePeriodResult = ResolvedPeriod &
  PeriodDescription & {
    setPeriod: (selection: PeriodSelection) => void;
  };

/** Periodvalet ur URL:en, med jämförelse och en setter som skriver tillbaka. */
export function usePeriod(options: Omit<ParseOptions, "now"> = {}): UsePeriodResult {
  const sp = useSearchParams();
  const now = useNow();
  const replace = useReplaceQuery();
  const { timeZone, earliest } = options;
  const resolved = useMemo(
    () => parsePeriod(sp, { now, timeZone, earliest }),
    [sp, now, timeZone, earliest],
  );
  const setPeriod = useCallback(
    (selection: PeriodSelection) => replace(withPeriod(sp, selection)),
    [replace, sp],
  );
  return { ...resolved, ...describePeriod(resolved), setPeriod };
}

/** Globalt filter på butik och automat (?butik=, ?automat=). */
export function useScope(): Scope & { setScope: (scope: Partial<Scope>) => void } {
  const sp = useSearchParams();
  const replace = useReplaceQuery();
  const scope = useMemo(() => parseScope(sp), [sp]);
  const setScope = useCallback(
    (next: Partial<Scope>) => replace(withScope(sp, next)),
    [replace, sp],
  );
  return { ...scope, setScope };
}

/** "?period=7d&butik=s1" att hänga på interna länkar så att vyn följer med. */
export function useCarriedQuery(): string {
  const sp = useSearchParams();
  return useMemo(() => carriedQuery(sp), [sp]);
}
