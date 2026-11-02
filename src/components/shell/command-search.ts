"use client";

import { useEffect, useRef, useState } from "react";

import type { PickList, PickResponse, SearchResponse } from "@/server/search/types";
import { MAX_SEARCH_LENGTH } from "@/server/search/types";

/**
 * Klientdelen av sökningen: anropar GET /sok med fördröjning (debounce) och avbryter
 * förfrågningar som hunnit bli inaktuella. Svar för samma söktext återanvänds så länge
 * paletten är öppen, så att det går fort att sudda tillbaka.
 */

/** Väntetid efter senaste tangenttryckningen innan servern frågas. */
export const SEARCH_DEBOUNCE_MS = 140;

export type RemoteState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly key: string; readonly previous: T | null }
  | { readonly status: "done"; readonly key: string; readonly data: T }
  | { readonly status: "error"; readonly key: string; readonly message: string };

/** Söktexten som skickas: samma normalisering som servern (cleanSearch). */
export function searchKey(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_LENGTH).trim();
}

class SearchHttpError extends Error {}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    signal,
    headers: { accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  const type = res.headers.get("content-type") ?? "";
  // Utan session skickar proxyn till inloggningen (HTML), och rutten svarar 401.
  if (res.status === 401 || res.redirected || !type.includes("application/json")) {
    throw new SearchHttpError("Sessionen har gått ut. Logga in igen.");
  }
  if (res.status === 403) throw new SearchHttpError("Du har inte behörighet att söka här.");
  if (res.status === 429) throw new SearchHttpError("För många sökningar. Vänta en stund.");
  if (!res.ok) throw new SearchHttpError("Sökningen svarar inte. Försök igen.");
  return (await res.json()) as T;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function messageOf(error: unknown): string {
  return error instanceof SearchHttpError ? error.message : "Sökningen svarar inte. Försök igen.";
}

/**
 * Hämtar `url(key)` för nyckeln, med fördröjning och avbrott. Tom nyckel ger "idle".
 * `resetToken` tömmer minnet (t.ex. när paletten öppnas igen eller organisationen byts).
 */
function useRemote<T>(
  key: string,
  url: (key: string) => string,
  options: { delay: number; resetToken: unknown },
): RemoteState<T> {
  const [state, setState] = useState<RemoteState<T>>({ status: "idle" });
  const memo = useRef(new Map<string, T>());
  const last = useRef<T | null>(null);
  const urlRef = useRef(url);
  useEffect(() => {
    urlRef.current = url;
  });

  useEffect(() => {
    memo.current = new Map();
    last.current = null;
  }, [options.resetToken]);

  useEffect(() => {
    if (!key) {
      const t = setTimeout(() => setState({ status: "idle" }), 0);
      return () => clearTimeout(t);
    }
    const cached = memo.current.get(key);
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        if (cached) {
          last.current = cached;
          setState({ status: "done", key, data: cached });
          return;
        }
        setState({ status: "loading", key, previous: last.current });
        getJson<T>(urlRef.current(key), controller.signal).then(
          (data) => {
            memo.current.set(key, data);
            last.current = data;
            setState({ status: "done", key, data });
          },
          (error: unknown) => {
            if (isAbort(error)) return;
            setState({ status: "error", key, message: messageOf(error) });
          },
        );
      },
      cached ? 0 : options.delay,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, options.delay, options.resetToken]);

  return state;
}

/** Sökningen för söktexten (tom text eller `enabled` falskt: ingen förfrågan). */
export function useRemoteSearch(
  query: string,
  enabled: boolean,
  resetToken: unknown,
): RemoteState<SearchResponse> {
  const key = enabled ? searchKey(query) : "";
  return useRemote<SearchResponse>(key, (k) => `/sok?${new URLSearchParams({ q: k })}`, {
    delay: SEARCH_DEBOUNCE_MS,
    resetToken,
  });
}

/** Listan för ett steg (null = ingen förfrågan). */
export function usePickList(
  request: { list: PickList; machineId?: string } | null,
  resetToken: unknown,
): RemoteState<PickResponse> {
  const key = request ? `${request.list}:${request.machineId ?? ""}` : "";
  return useRemote<PickResponse>(
    key,
    (k) => {
      const [list, machine] = k.split(":");
      const sp = new URLSearchParams({ lista: list ?? "" });
      if (machine) sp.set("automat", machine);
      return `/sok?${sp}`;
    },
    { delay: 0, resetToken },
  );
}

/** Data för nyckeln, eller föregående svar medan nästa laddas (så att listan inte blinkar). */
export function remoteData<T>(state: RemoteState<T>): T | null {
  if (state.status === "done") return state.data;
  if (state.status === "loading") return state.previous;
  return null;
}
