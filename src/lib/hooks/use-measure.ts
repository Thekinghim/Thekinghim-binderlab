"use client";

import { useLayoutEffect, useRef, useState } from "react";

/** Mäter ett elements bredd med ResizeObserver, för responsiva diagram. */
export function useMeasure<T extends HTMLElement>(initialWidth = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initialWidth);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width] as const;
}
