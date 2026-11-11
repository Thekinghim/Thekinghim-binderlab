"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

import { DRIFT_TABS, driftTabActive } from "../_lib/nav";

/**
 * Undersidorna i Drift. Aktiv sida har ett 2 px indexstreck och aria-current. Under md är
 * raden en segmentknapp (fyra lika breda val), så att den inte ser ut som en andra flikrad. Till höger,
 * från md, "Fyll på" (mobilsidan vid automaten) för den som får registrera påfyllningar; på
 * mobilen är det Påfyllning som har den stora knappen, så att flikarna får plats.
 */
export function DriftNav({ canRefill = false }: { canRefill?: boolean }) {
  const pathname = usePathname();
  return (
    <div className="flex items-end gap-3">
      <nav aria-label="Drift" className="-mx-4 min-w-0 flex-1 overflow-x-auto px-4 md:mx-0 md:px-0">
        <ul className="flex min-w-max gap-1 border-b border-line max-md:grid max-md:min-w-0 max-md:auto-cols-fr max-md:grid-flow-col max-md:gap-0.5 max-md:rounded-md max-md:border max-md:border-line-strong max-md:p-0.5">
          {DRIFT_TABS.map((item) => {
            const on = driftTabActive(item.href, pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "-mb-px inline-flex h-9 items-center border-b-2 px-3 text-sm transition-colors duration-fast max-md:mb-0 max-md:h-11 max-md:w-full max-md:justify-center max-md:rounded-sm max-md:border-b-0 max-md:px-1",
                    on
                      ? "border-fg text-fg max-md:bg-inverse max-md:font-medium max-md:text-on-inverse"
                      : "border-transparent text-muted hover:text-fg",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {/* Påfyllning har en stor Fyll på-knapp själv. */}
      {canRefill && !driftTabActive("/drift/pafyllning", pathname) ? (
        <Link
          href="/fyll-pa"
          className="mb-1 hidden h-9 shrink-0 items-center gap-1.5 rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse transition-colors duration-fast hover:bg-inverse-hover md:inline-flex"
        >
          Fyll på
          <span aria-hidden>→</span>
        </Link>
      ) : null}
    </div>
  );
}
