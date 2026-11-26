import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * En rad i en lista (Kräver åtgärd, Att göra, Butiker): rubrik och undertext till vänster,
 * innehåll i mitten (status, fyllnad, text), knappar till höger. På telefon hamnar innehållet
 * under rubriken. Med `href` är hela raden en länk (då utan knappar), utan förhämtning: listor har
 * många rader och telefonen ska inte hämta alla sidor i förväg.
 */
export function ListRow({
  title,
  sub,
  children,
  actions,
  href,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  href?: string;
  className?: string;
}) {
  const inner = (
    <>
      <div className="t">
        <b>{title}</b>
        {sub ? <small>{sub}</small> : null}
      </div>
      <div className="m">{children}</div>
      {actions ? <div className="a">{actions}</div> : <div className="a" />}
    </>
  );
  return href ? (
    <Link href={href} className={cn("v2-row", className)} prefetch={false}>
      {inner}
    </Link>
  ) : (
    <div className={cn("v2-row", className)}>{inner}</div>
  );
}
