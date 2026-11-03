"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Länkar pekar på ett avsnitt med #ankare (t.ex. #leverantorer). Avsnitten ligger i
 * flikar (?vy=): byt till rätt flik, behåll ankaret och scrolla dit när fliken visas.
 * `defaultTab` är fliken som visas utan ?vy=.
 */
export function HashTab({
  map,
  defaultTab,
}: {
  map: Readonly<Record<string, string>>;
  defaultTab: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const scrolled = useRef<string | null>(null);

  useEffect(() => {
    let raf = 0;
    const go = () => {
      const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      const tab = map[hash];
      if (!tab) return;
      if ((searchParams.get("vy") ?? defaultTab) !== tab) {
        const q = new URLSearchParams(searchParams.toString());
        q.set("vy", tab);
        router.replace(`${pathname}?${q.toString()}#${hash}`, { scroll: false });
        return;
      }
      // Rätt flik visas: scrolla till avsnittet en gång per ankare.
      if (scrolled.current === hash) return;
      scrolled.current = hash;
      raf = requestAnimationFrame(() =>
        document.getElementById(hash)?.scrollIntoView({ block: "start" }),
      );
    };
    const onHash = () => {
      scrolled.current = null;
      go();
    };
    go();
    window.addEventListener("hashchange", onHash);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("hashchange", onHash);
    };
  }, [map, defaultTab, pathname, router, searchParams]);
  return null;
}
