"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "@/lib/tokens";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Räknar från föregående värde till nästa när värdet byts (t.ex. vid
 * periodbyte). Första renderingen visar slutvärdet direkt, så att
 * serverrenderad HTML stämmer och inget hoppar vid sidladdning.
 */
export function useCountUp(target: number, duration: number = motion.count): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    if (prefersReducedMotion()) {
      fromRef.current = target;
      frameRef.current = requestAnimationFrame(() => setValue(target));
      return () => {
        if (frameRef.current) cancelAnimationFrame(frameRef.current);
      };
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + (target - from) * eased;
      setValue(next);
      fromRef.current = next;
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [target, duration]);

  return value;
}
