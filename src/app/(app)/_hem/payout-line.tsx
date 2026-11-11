import { cn } from "@/lib/cn";

import { HomeRow } from "./home-row";
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
            <HomeRow
              href={p.href}
              tone={p.late ? "signal" : "plain"}
              data-payout={p.late ? "late" : "due"}
            >
              {p.title}
            </HomeRow>
          </li>
        );
      })}
    </ul>
  );
}
