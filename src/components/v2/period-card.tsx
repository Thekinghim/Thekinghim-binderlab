"use client";

/**
 * Ett kort som visar vald period (Hem): en egen Suspense-gräns med perioden som nyckel.
 *
 * Ett periodbyte ändrar bara sökparametrarna, så Next återanvänder sidans Suspense-gränser,
 * och React håller då kvar den gamla sidan tills det långsammaste kortet är klart (en
 * gräns som redan visar innehåll döljs aldrig i en transition). Med perioden som nyckel blir
 * gränsen ny vid bytet: kortet visar direkt sin laddningsruta, och övriga kort (och
 * periodens hjältekort först av allt) kommer var för sig när de är klara.
 *
 * Laddningsrutan får det gamla kortets höjd (mätt när bytet börjar, medan det gamla kortet
 * ännu syns), så att sidan inte hoppar. De två dolda markörerna kring kortet tar ingen plats
 * (display: none) och avgör vilket element som är kortet.
 */

import { cloneElement, isValidElement, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { useShellNavigation } from "@/components/shell/shell-navigation";

import { SafeSuspense } from "./safe-suspense";

export function PeriodCard({
  periodKey,
  fallback,
  sized = true,
  children,
}: {
  /** Vald period och filter: ny nyckel ger en ny gräns (laddningsrutan visas direkt). */
  periodKey: string;
  fallback: ReactNode;
  /** false: laddningsrutan behåller sin egen höjd (t.ex. hjältekortets egen ruta). */
  sized?: boolean;
  children: ReactNode;
}) {
  const start = useRef<HTMLSpanElement>(null);
  const end = useRef<HTMLSpanElement>(null);
  const pending = useShellNavigation()?.pending ?? false;
  const [height, setHeight] = useState<number | null>(null);

  // Bytet börjar: mät kortet som syns nu (bara när det är exakt ett element mellan markörerna).
  useLayoutEffect(() => {
    if (!pending || !sized) return;
    const el = start.current?.nextElementSibling;
    if (!el || el === end.current || el.nextElementSibling !== end.current) return;
    const h = Math.round(el.getBoundingClientRect().height);
    setHeight(h > 0 ? h : null);
  }, [pending, sized]);

  const shown =
    sized && height !== null && isValidElement(fallback)
      ? withMinHeight(fallback as ReactElement<{ style?: CSSProperties }>, height)
      : fallback;

  return (
    <>
      <span ref={start} hidden />
      <SafeSuspense key={periodKey} fallback={shown}>
        {children}
      </SafeSuspense>
      <span ref={end} hidden />
    </>
  );
}

function withMinHeight(el: ReactElement<{ style?: CSSProperties }>, px: number): ReactElement {
  return cloneElement(el, { style: { ...el.props.style, minHeight: px } });
}
