import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Panelen i V2 (prototypens .pn): vit yta, 1 px kant (som skugga), radie 12, rubrikrad med
 * etikett, ett valfritt antal (orange) och en länk "→" eller egna knappar till höger.
 */
export function Card({
  title,
  count,
  link,
  actions,
  children,
  className,
  id,
  as: Tag = "section",
}: {
  title?: ReactNode;
  /** Antalet efter rubriken ("Kräver åtgärd · 12"). */
  count?: number | null;
  /** Länken i rubrikraden, t.ex. { href: "/rutt", label: "Packlista" } (pilen läggs till). */
  link?: { href: string; label: string };
  /** Egna kontroller i rubrikraden (ersätter länken). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  as?: "section" | "div" | "article";
}) {
  return (
    <Tag id={id} className={cn("v2-card", className)}>
      {title !== undefined ? (
        <div className="v2-card-hd">
          <h2>
            {title}
            {count !== undefined && count !== null ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="n">{count}</span>
              </>
            ) : null}
          </h2>
          {actions ??
            (link ? (
              // Ingen förhämtning: kortens länkar är många och sällan tryckta (telefonens data).
              <Link className="lk" href={link.href} prefetch={false}>
                {link.label} <span aria-hidden="true">→</span>
              </Link>
            ) : null)}
        </div>
      ) : null}
      {children}
    </Tag>
  );
}

/** Innehåll med kortets standardluft (16 × 18 px). */
export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("v2-card-body", className)}>{children}</div>;
}
