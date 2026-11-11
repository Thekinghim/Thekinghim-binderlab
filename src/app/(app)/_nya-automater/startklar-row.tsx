/**
 * "Startklar" överst på Att göra (runda 2, R2-9): en automat har steg kvar som går att göra.
 * "BL-004: 3 av 7 klart. Nästa: lägg in avtalet." med en länk till rätt formulär. Samma
 * lista som överst på automatens sida (src/server/onboarding/machine-ready.ts). Bara ägare
 * och admin (loadStartklarFor ger null för andra).
 */

import Link from "next/link";

import type { ReadinessTodo } from "@/server/onboarding/machine-ready";

export function StartklarRow({ todo }: { todo: ReadinessTodo | null }) {
  if (!todo) return null;
  return (
    <section
      aria-label="Startklar"
      className="rise mb-6 flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3 max-md:mb-4 max-md:px-3 max-md:py-2"
    >
      <p className="min-w-0 text-base text-fg max-md:text-sm">{`${todo.title}.`}</p>
      <Link
        href={todo.href}
        className="inline-flex min-h-11 shrink-0 items-center text-sm text-muted underline-offset-2 hover:underline"
      >
        {todo.machines === 1 ? "Öppna" : "Visa"}
      </Link>
    </section>
  );
}
