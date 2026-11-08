import Link from "next/link";

import { cn } from "@/lib/cn";

import type { HomePayout } from "./model";

/**
 * Utbetalningen till butikerna överst på Hem: "Betala butikerna: 12 172 kr senast 15 nov."
 * eller "Skapa oktober-avräkningarna", till Butiker → Utbetalning. Försenad = signalfärg.
 * Samma punkter som i Att göra (texten kommer därifrån), men bara här på Hem.
 */
export function PayoutLines({
  payouts,
  className,
}: {
  payouts: readonly HomePayout[];
  className?: string;
}) {
  if (payouts.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-2", className)} aria-label="Utbetalning till butikerna">
      {payouts.map((p) => {
        return (
          <li key={p.key}>
            <Link
              href={p.href}
              className={cn(
                "group flex min-h-11 items-center justify-between gap-3 rounded-sm border bg-surface px-4 py-2.5 text-base text-fg hover:bg-hover",
                p.late ? "border-signal-line" : "border-line",
              )}
              data-payout={p.late ? "late" : "due"}
            >
              <span className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className={cn("inline-block size-2 shrink-0", p.late ? "bg-signal" : "bg-fg")}
                />
                <span className={p.late ? "text-signal-fg" : undefined}>{p.title}</span>
              </span>
              <span aria-hidden className="text-subtle transition-colors group-hover:text-fg">
                →
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
