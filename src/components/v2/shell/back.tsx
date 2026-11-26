"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { backTargetFor } from "@/app/(app)/crumbs";
import { v2MobileNavForRole } from "@/components/shell/nav";

import { canGoBackInApp, recordPath } from "./back-history";
import { useV2Shell } from "./shell-context";

/** Skalet: för in varje sidbyte i appens historik (back-history.ts). */
export function BackHistory() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) recordPath(pathname);
  }, [pathname]);
  return null;
}

/**
 * Tillbaka-pilen i sidhuvudet på telefon (under 900 px), på alla sidor utom flikarnas egna.
 * Finns en sida i appen före: router.back() (som svepet bakåt, sidan och läget kommer
 * tillbaka). Annars, och innan sidan har laddat klart, en vanlig länk till föräldersidan.
 */
export function V2Back() {
  const shell = useV2Shell();
  const pathname = usePathname();
  const router = useRouter();
  if (!shell || shell.role === "store") return null;
  const target = backTargetFor(pathname, v2MobileNavForRole(shell.role));
  if (!target) return null;
  return (
    <Link
      href={target.href}
      prefetch={false}
      className="v2-back"
      aria-label={`Tillbaka till ${target.label}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (canGoBackInApp()) {
          e.preventDefault();
          router.back();
        }
      }}
    >
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <path
          d="M15 5l-7 7 7 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </Link>
  );
}
