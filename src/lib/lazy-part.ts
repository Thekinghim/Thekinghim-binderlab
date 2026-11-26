"use client";

import { createElement, useEffect, useState, type ComponentType } from "react";

/**
 * En del av sidan som laddas först när den behövs (kommandopaletten, periodarket, AI-panelen),
 * utan next/dynamic. next/dynamic visar delen genom en Suspense-gräns, och React väntar då
 * upp till 300 ms innan innehållet visas första gången, även när koden redan är hämtad.
 * Det märktes som ett segt första tryck. Här hämtas koden med import() och `Component` ritar
 * delen så fort koden finns (direkt om den redan är hämtad), utan Suspense.
 */
export interface LazyPart<P extends object> {
  /** Startar hämtningen i förväg (t.ex. när fingret landar). Ett misslyckat försök görs om. */
  load(): Promise<ComponentType<P>>;
  /** Ritar delen när koden finns, annars ingenting (som next/dynamic utan laddningsvy). */
  Component: ComponentType<P>;
}

export function lazyPart<P extends object>(loader: () => Promise<ComponentType<P>>): LazyPart<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;

  function load(): Promise<ComponentType<P>> {
    if (loaded) return Promise.resolve(loaded);
    pending ??= loader().then(
      (c) => {
        loaded = c;
        return c;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  }

  function Component(props: P) {
    const [part, setPart] = useState<ComponentType<P> | null>(() => loaded);
    useEffect(() => {
      if (part) return;
      let live = true;
      load().then(
        (c) => {
          if (live) setPart(() => c);
        },
        () => {
          // Nätet svek: delen visas inte (som med next/dynamic). Nästa montering försöker igen.
        },
      );
      return () => {
        live = false;
      };
    }, [part]);
    return part ? createElement(part, props) : null;
  }

  return { load, Component };
}
