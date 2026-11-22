import Link from "next/link";

import { ButtonLink } from "@/components/v2/button";
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
    <ul aria-label="Butiker på väg in" className="flex flex-col divide-y divide-v2-line2">
      {lists.map((l) => (
        <li
          key={l.storeId}
          data-startlista={l.storeId}
          className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center md:justify-between md:gap-6"
        >
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Link
                href={l.href}
                className="rounded-v2-sm text-v2-md font-[550] text-v2-ink hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
              >
                {l.name}
              </Link>
              <span className="tnum text-v2-sm text-v2-mute">{l.progress}</span>
            </div>
            <ol className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-x-4">
              {l.steps.map((step) => (
                <li key={step.id} className="flex items-center gap-2 text-v2-sm">
                  <span
                    aria-hidden
                    className={cn(
                      "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border text-[10px] leading-none",
                      step.done
                        ? "border-v2-ink bg-v2-ink text-v2-panel"
                        : "border-v2-faint text-transparent",
                    )}
                  >
                    ✓
                  </span>
                  <span className={step.done ? "text-v2-mute" : "text-v2-ink"}>
                    <span className="sr-only">{step.done ? "Klart: " : "Saknas: "}</span>
                    {step.label}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          {canEdit && l.next ? (
            <ButtonLink href={l.next.href} variant="act" touch className="w-fit shrink-0">
              {l.next.label}
            </ButtonLink>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
