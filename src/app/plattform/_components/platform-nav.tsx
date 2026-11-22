"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/plattform", label: "Kunder" },
  { href: "/plattform/underlag", label: "Fakturaunderlag" },
] as const;

/** Plattformens flikar (Kunder · Fakturaunderlag) som V2:s underflikar. */
export function PlatformNav() {
  const path = usePathname();
  return (
    <nav aria-label="Plattform" className="v2-subnav !mb-0 !border-b-0">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
