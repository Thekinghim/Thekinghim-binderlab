"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ButtonLink } from "@/components/v2/button";

import { DRIFT_TABS, driftTabActive } from "../_lib/nav";

/**
 * Undersidorna i Drift som V2-segment (länkar med aria-current). På telefon fyller segmentet
 * bredden (fyra lika breda val). Till höger, från 900 px, "Fyll på" (mobilsidan vid
 * automaten) för den som får registrera påfyllningar; på telefon har Påfyllning den stora
 * knappen, så att flikarna får plats.
 */
export function DriftNav({ canRefill = false }: { canRefill?: boolean }) {
  const pathname = usePathname();
  return (
    <div className="ops-bar">
      <nav aria-label="Drift" className="ops-seg full">
        {DRIFT_TABS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={driftTabActive(item.href, pathname) ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {/* Påfyllning har en stor Fyll på-knapp själv. */}
      {canRefill && !driftTabActive("/drift/pafyllning", pathname) ? (
        <ButtonLink href="/fyll-pa" variant="act" className="max-[900px]:hidden">
          Fyll på <span aria-hidden="true">→</span>
        </ButtonLink>
      ) : null}
    </div>
  );
}
