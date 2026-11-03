import Link from "next/link";

import { formatInt, formatPercent, formatSek, NBSP } from "@/lib/format";

import type { UnpricedView } from "../_lib/types";

function listNames(names: readonly string[], max = 3): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} och ${formatInt(rest)} till`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} och ${shown[shown.length - 1]}`;
}

/**
 * Raden under nyckeltalen: vinsten och marginalen räknar inte med order utan inköpspris
 * (berakningar.md avsnitt 5). Antal, andel, belopp, vilka titlar och vägen dit priset
 * läggs in. För en automat även butikshyran på orderna, som dras från organisationens
 * vinst (ej fördelad hyra) och inte från automatens.
 */
export function UnpricedNote({ unpriced, canEdit }: { unpriced: UnpricedView; canEdit: boolean }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted">
      <span
        title={`${listNames(unpriced.titles)}${unpriced.rentOre > 0 ? ` · butikshyra ${formatSek(unpriced.rentOre / 100)} dras från organisationen` : ""}`}
      >
        {formatInt(unpriced.orders)}
        {NBSP}order utan inköpspris ({formatPercent(unpriced.shareBp / 10_000, 1)},{" "}
        {formatSek(unpriced.revenueOre / 100)}) ingår inte i vinsten.
      </span>
      <Link
        href={unpriced.href}
        className="meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
      >
        <span>{canEdit ? "Lägg in inköpspris" : "Visa inköpspriser"}</span>
        <span aria-hidden className="text-subtle">
          →
        </span>
      </Link>
    </p>
  );
}
