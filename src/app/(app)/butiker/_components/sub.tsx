import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Underavsnitt i en sektion: mono-etikett med mått ("03.1 / KÖP PER TIMME · 30 D"),
 * metadata till höger och en mening med en siffra (h3). Samma mönster som Sub på /design.
 */
export function Sub({
  index,
  label,
  meta,
  title,
  id,
  className,
  children,
}: {
  index?: string;
  label: string;
  meta?: ReactNode;
  title?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line pt-3">
        <p className="label min-w-0 text-subtle">
          {index ? (
            <>
              <span className="tnum text-fg">{index}</span>
              <span aria-hidden className="text-faint">
                {" / "}
              </span>
            </>
          ) : null}
          {label}
        </p>
        {meta ? <p className="meta tnum text-subtle">{meta}</p> : null}
      </div>
      {title ? (
        <h3 id={id} className="mt-2 text-md font-medium text-balance hyphens-none text-fg">
          {title}
        </h3>
      ) : null}
      <div className={cn(title ? "mt-5" : "mt-4", "min-w-0")}>{children}</div>
    </div>
  );
}
