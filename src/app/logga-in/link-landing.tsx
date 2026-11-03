"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { parseLinkFragment, type LinkFragment } from "./link-fragment";

/**
 * Läser länkens fragment en gång när sidan visas och tar sedan bort det ur
 * adressfältet (tokens ska inte ligga kvar i historiken eller delas vidare).
 * `null` tills sidan har läst det, så att inget hoppar vid hydrering.
 */
export function useLinkFragment(): LinkFragment | null {
  const [fragment, setFragment] = useState<LinkFragment | null>(null);
  // Läses en gång per sida: effekten kan köras två gånger (React Strict Mode), och
  // andra gången är fragmentet redan borttaget.
  const read = useRef<LinkFragment | null>(null);
  useEffect(() => {
    if (read.current === null) {
      const { hash, search, pathname } = window.location;
      read.current = parseLinkFragment(hash, search);
      if (hash) {
        window.history.replaceState(window.history.state, "", `${pathname}${search}`);
      }
    }
    // Fragmentet finns bara i webbläsaren: läses efter hydrering.
    setFragment(read.current);
  }, []);
  return fragment;
}

const PRIMARY =
  "inline-flex h-12 w-full items-center justify-center rounded-sm border border-inverse bg-inverse px-4 text-base font-medium text-on-inverse hover:bg-inverse-hover";
const SECONDARY =
  "inline-flex h-12 w-full items-center justify-center rounded-sm border border-line-strong bg-surface px-4 text-base font-medium text-fg hover:border-line-control hover:bg-hover";

/** Plats för knappen medan fragmentet läses: samma höjd, inget hopp. */
export function LinkPending() {
  return <div aria-hidden className="h-12 w-full animate-pulse-soft rounded-sm bg-hover" />;
}

/**
 * När länken inte går att använda (gammal, redan använd, förhandsvisad av
 * e-postprogrammet eller ofullständig): en rad och två stora knappar.
 */
export function LinkFailed({
  retryHref = "/logga-in",
  retryLabel = "Skicka ny länk",
}: {
  retryHref?: string;
  retryLabel?: string;
}) {
  return (
    <div className="fade-in flex flex-col gap-4" role="alert">
      <p className="text-base text-signal-fg">Länken gick inte att öppna.</p>
      <Link href="/logga-in?vy=losenord" className={PRIMARY}>
        Logga in med lösenord
      </Link>
      <Link href={retryHref} className={SECONDARY}>
        {retryLabel}
      </Link>
    </div>
  );
}
