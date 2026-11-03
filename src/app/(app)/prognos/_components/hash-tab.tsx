"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Äldre länkar pekar på ett avsnitt med #ankare (t.ex. #forlorad-forsaljning från Hem).
 * Avsnitten ligger nu i flikar (?vy=): byt till rätt flik och behåll ankaret.
 */
export function HashTab({ map }: { map: Readonly<Record<string, string>> }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const tab = map[hash];
    if (!tab || searchParams.get("vy") === tab) return;
    const q = new URLSearchParams(searchParams.toString());
    if (tab === Object.values(map)[0] && !searchParams.has("vy")) return;
    q.set("vy", tab);
    router.replace(`${pathname}?${q.toString()}#${hash}`, { scroll: false });
  }, [map, pathname, router, searchParams]);
  return null;
}
