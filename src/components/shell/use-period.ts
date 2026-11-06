"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  carriedQuery,
  describePeriod,
  parsePeriod,
  parseScope,
  parseVmbView,
  STORE_SHARE_COOKIE,
  VMB_PARAM,
  withPeriod,
  withScope,
  withStoreShareView,
  withVmbView,
  type ParseOptions,
  type PeriodDescription,
  type PeriodSelection,
  type ResolvedPeriod,
  type Scope,
} from "./period-state";
import { useShellNavigation } from "./shell-navigation";

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

/**
 * Sökparametrarna och en setter som skriver tillbaka till URL:en.
 *
 * Inne i AppShell går skrivningen via skalets navigering (./shell-navigation): medan
 * servern räknar är det den väntande adressen som gäller här, så att knappen,
 * periodraden och filtren visar valet direkt, och ett nytt val alltid utgår från det
 * senaste (inte från URL:en som ännu inte bytts).
 */
function useQuery(): [URLSearchParams, (next: URLSearchParams) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const nav = useShellNavigation();
  const target = nav?.target ?? null;
  const params = useMemo(() => {
    if (target) {
      const url = new URL(target, "http://x");
      if (url.pathname === pathname) return new URLSearchParams(url.search);
    }
    return new URLSearchParams(sp.toString());
  }, [sp, target, pathname]);
  const navReplace = nav?.replace;
  const replace = useCallback(
    (next: URLSearchParams) => {
      const q = next.toString();
      const href = q ? `${pathname}?${q}` : pathname;
      if (navReplace) navReplace(href);
      else router.replace(href, { scroll: false });
    },
    [router, pathname, navReplace],
  );
  return [params, replace];
}

export type UsePeriodResult = ResolvedPeriod &
  PeriodDescription & {
    setPeriod: (selection: PeriodSelection) => void;
  };

/** Periodvalet ur URL:en, med jämförelse och en setter som skriver tillbaka. */
export function usePeriod(options: Omit<ParseOptions, "now"> = {}): UsePeriodResult {
  const [sp, replace] = useQuery();
  const now = useNow();
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
  const [sp, replace] = useQuery();
  const scope = useMemo(() => parseScope(sp), [sp]);
  const setScope = useCallback(
    (next: Partial<Scope>) => replace(withScope(sp, next)),
    [replace, sp],
  );
  return { ...scope, setScope };
}

/** Nyckeln i localStorage för användarens senaste val av "Med VMB". */
export function vmbStorageKey(userKey: string): string {
  return `binderlab:vmb:${userKey}`;
}

function readStored(key: string | null): "1" | "0" | null {
  if (!key) return null;
  try {
    const v = window.localStorage.getItem(key);
    return v === "1" || v === "0" ? v : null;
  } catch {
    return null;
  }
}

function writeStored(key: string | null, on: boolean): void {
  if (!key) return;
  try {
    window.localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Privat läge eller blockerad lagring: valet gäller bara URL:en.
  }
}

/**
 * Vyknappen "Med VMB" (?vmb=1). Valet minns per användare i localStorage (`userKey`):
 * saknas parametern i URL:en och användaren senast valde på, sätts den. En länk med
 * ?vmb=1 visar alltid vyn med VMB.
 */
export function useVmbView(userKey: string | null): {
  on: boolean;
  setOn: (on: boolean) => void;
} {
  const [sp, replace] = useQuery();
  const on = parseVmbView(sp);
  const key = userKey ? vmbStorageKey(userKey) : null;
  const hasParam = sp.has(VMB_PARAM);
  useEffect(() => {
    if (!hasParam && readStored(key) === "1") replace(withVmbView(sp, true));
    // Bara när sidan öppnas eller parametern försvinner, inte vid varje annat val.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hasParam]);
  const setOn = useCallback(
    (next: boolean) => {
      writeStored(key, next);
      replace(withVmbView(sp, next));
    },
    [key, replace, sp],
  );
  return { on, setOn };
}

/**
 * Sparar vyknappen "Visa butikernas andel" i kakan (STORE_SHARE_COOKIE) som proxyn läser, så
 * att valet gäller på alla sidor, även när en länk saknar ?andel. Av = kakan tas bort.
 */
export function writeStoreShareCookie(on: boolean): void {
  try {
    document.cookie = on
      ? `${STORE_SHARE_COOKIE}=1; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
      : `${STORE_SHARE_COOKIE}=; path=/; max-age=0; samesite=lax`;
  } catch {
    // Kakor avstängda: valet följer ändå med i URL:en (?andel=1).
  }
}

/**
 * Vyknappen "Visa butikernas andel". `serverOn` är förfrågans läge (?andel=1 eller kakan,
 * requestStoreShareView), samma som siffrorna på sidan räknades med. Knappen sparar valet i
 * kakan och sätter ?andel=1 (av: tar bort parametern), så att servern räknar om sidan.
 */
export function useStoreShareView(serverOn: boolean): {
  on: boolean;
  setOn: (on: boolean) => void;
} {
  const [sp, replace] = useQuery();
  // Visas direkt vid klick, tills servern har räknat om sidan med det nya läget.
  const [pending, setPending] = useState<boolean | null>(null);
  if (pending !== null && pending === serverOn) setPending(null);
  const on = pending ?? serverOn;
  const setOn = useCallback(
    (next: boolean) => {
      writeStoreShareCookie(next);
      setPending(next);
      replace(withStoreShareView(sp, next));
    },
    [replace, sp],
  );
  return { on, setOn };
}

/** "?period=7d&butik=s1" att hänga på interna länkar så att vyn följer med. */
export function useCarriedQuery(): string {
  const [sp] = useQuery();
  return useMemo(() => carriedQuery(sp), [sp]);
}
