import type { ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

/**
 * Ett V2-kort som är stängt tills man trycker på rubrikraden (details/summary, ingen JS):
 * för Konton, Ändringslogg och annat man sällan behöver. `aside` står grått till höger.
 */
export function FoldCard({
  id,
  title,
  aside,
  open,
  children,
  className,
}: {
  id?: string;
  title: ReactNode;
  aside?: ReactNode;
  open?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("v2-card st-fold scroll-mt-24", className)} id={id} open={open}>
      <summary className="v2-card-hd">
        <h2>{title}</h2>
        <span className="chev">
          {aside ? <span className="min-w-0 truncate">{aside}</span> : null}
          <Icon name="chevronDown" size={14} />
        </span>
      </summary>
      {children}
    </details>
  );
}
