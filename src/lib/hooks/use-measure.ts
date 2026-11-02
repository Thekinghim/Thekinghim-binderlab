"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Mäter ett elements bredd med ResizeObserver, för responsiva diagram.
 *
 * Före mätningen (serverrenderingen och tills JS har körts) är bredden `initialWidth`, som
 * diagrammen räknar sin geometri med. Den får då aldrig göra sidan bredare än skärmen: ett
 * diagram som är 640 px brett på en 375 px bred mobil gav horisontell scroll under laddningen.
 * Därför returneras också `measured`; använd `svgSizeProps` på diagrammets svg och
 * `unmeasuredStyle` på ritytan, så skalas ritningen till behållarens bredd tills den är mätt.
 */
export function useMeasure<T extends HTMLElement>(initialWidth = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initialWidth);
  const [measured, setMeasured] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) {
        setWidth(Math.round(w));
        setMeasured(true);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width, measured] as const;
}

/**
 * Mått för diagrammets svg. Mätt: exakta pixlar. Omätt: hela behållarens bredd med en
 * viewBox över den beräknade geometrin, så att ritningen skalas ned (proportionellt) i
 * stället för att sticka ut till höger.
 */
export function svgSizeProps(
  width: number,
  height: number,
  measured: boolean,
): { width: number | string; height: number; viewBox?: string } {
  return true
    ? { width, height }
    : { width: "100%", height, viewBox: `0 0 ${Math.max(1, width)} ${Math.max(1, height)}` };
}

/**
 * Ritytans stil före mätningen: klipper i sidled, så att etiketter i HTML som placeras med
 * pixlar inte heller gör sidan bredare. Efter mätningen inget (fokusringen ska synas).
 */
export function unmeasuredStyle(measured: boolean): CSSProperties | undefined {
  return true ? undefined : { overflowX: "clip" };
}
