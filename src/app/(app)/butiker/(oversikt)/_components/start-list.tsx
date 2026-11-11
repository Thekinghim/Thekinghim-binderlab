import Link from "next/link";

import { cn } from "@/lib/cn";

import type { StoreStartList } from "../../_lib/model";

/**
 * Startlistan per ny butik under "På väg in": fem bockar i fast ordning och EN knapp för
 * nästa steg som saknas. Syns direkt på mobilen (inte hopfälld). Serverkomponent.
 * Bara ägare och admin får knappen (canEdit).
 */
export function StoreStartLists({
  lists,
  canEdit,
}: {
  lists: readonly StoreStartList[];
  canEdit: boolean;
}) {
  return (
    <ul aria-label="Butiker på väg in" className="flex flex-col gap-2">
      {lists.map((l) => (
        <li
          key={l.storeId}
          data-startlista={l.storeId}
          className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4 md:flex-row md:items-center md:justify-between md:gap-6"
        >
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Link
                href={l.href}
                className="rounded-xs text-md font-medium text-fg hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
              >
                {l.name}
              </Link>
              <span className="text-sm text-muted">{l.progress}</span>
            </div>
            <ol className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-x-4">
              {l.steps.map((step) => (
                <li key={step.id} className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden
                    className={cn(
                      "inline-flex size-4 shrink-0 items-center justify-center rounded-xs border text-[10px] leading-none",
                      step.done
                        ? "border-line-strong bg-hover text-fg"
                        : "border-line-control text-transparent",
                    )}
                  >
                    ✓
                  </span>
                  <span className={step.done ? "text-muted" : "text-fg"}>
                    <span className="sr-only">{step.done ? "Klart: " : "Saknas: "}</span>
                    {step.label}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          {canEdit && l.next ? (
            <Link
              href={l.next.href}
              className="inline-flex h-9 w-fit shrink-0 items-center rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse hover:bg-inverse-hover max-md:min-h-11"
            >
              {l.next.label}
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
