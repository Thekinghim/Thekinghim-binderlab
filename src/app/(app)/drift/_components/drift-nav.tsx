"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

const ITEMS = [
  { href: "/drift", label: "Maskinhälsa" },
  { href: "/drift/besok", label: "Besöksplan" },
  { href: "/drift/pafyllning", label: "Påfyllning" },
  { href: "/drift/larm", label: "Larminställningar" },
] as const;

/** Undersidorna i Drift. Aktiv sida har ett 2 px indexstreck och aria-current. */
export function DriftNav() {
  const pathname = usePathname();
  const active = (href: string) =>
    href === "/drift"
      ? pathname === "/drift" || pathname.startsWith("/drift/automat")
      : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <nav aria-label="Drift" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <ul className="flex min-w-max gap-1 border-b border-line">
        {ITEMS.map((item) => {
          const on = active(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-9 items-center border-b-2 px-3 text-sm transition-colors duration-fast",
                  on ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
