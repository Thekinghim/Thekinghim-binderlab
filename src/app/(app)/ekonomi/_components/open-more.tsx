"use client";

import { useEffect } from "react";

/**
 * Öppnar "Fler val" (<details id={detailsId}>) när adressen slutar på något av `hashes`
 * (t.ex. #kontoplan från kontraktets "Lägg in organisationsnumret") och rullar dit.
 */
export function OpenMoreOnHash({
  detailsId,
  hashes,
}: {
  detailsId: string;
  hashes: readonly string[];
}) {
  useEffect(() => {
    const go = () => {
      const hash = decodeURIComponent(window.location.hash.slice(1));
      if (!hashes.includes(hash)) return;
      const el = document.getElementById(detailsId);
      if (el instanceof HTMLDetailsElement) el.open = true;
      (document.getElementById(hash) ?? el)?.scrollIntoView({ block: "start" });
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [detailsId, hashes]);
  return null;
}
