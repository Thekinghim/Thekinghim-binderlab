import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Ett kort i en sektion på butikens sida (V2): kortrubrik 14 px halvfet med ett grått mått
 * till höger ("3 villkor"), en mening (h3) och innehållet. Inga versaletiketter.
 */
export function Sub({
  label,
  meta,
  title,
  id,
  className,
  children,
}: {
  label: string;
  meta?: ReactNode;
  title?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("v2-card min-w-0", className)} aria-label={label}>
      <div className="v2-card-hd">
        <h2>{label}</h2>
        {meta ? <span className="tnum text-v2-sm text-v2-mute">{meta}</span> : null}
      </div>
      <div className="v2-card-body flex min-w-0 flex-col gap-4">
        {title ? (
          <h3 id={id} className="text-v2-md font-[550] text-balance text-v2-ink">
            {title}
          </h3>
        ) : null}
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}
