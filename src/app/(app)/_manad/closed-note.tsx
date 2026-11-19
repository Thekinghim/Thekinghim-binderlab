import { requireViewer } from "@/server/data/core";
import { closedMonthsLine, REOPEN_HINT } from "@/server/periods/model";
import { loadClosedMonthKeysFor } from "@/server/periods/service";

/**
 * Raden som visas där priser, avtal, testköp och återbetalningar ändras, när någon månad
 * är stängd: "Oktober 2026 är stängd. Där ändras inget. Ägaren kan öppna månaden igen
 * under Butiker → Utbetalning." Ingenting utan stängda månader.
 */
export function ClosedMonthsNote({
  months,
  className = "",
}: {
  months: readonly string[];
  className?: string;
}) {
  const line = closedMonthsLine(months);
  if (!line) return null;
  return (
    <p className={`text-sm text-muted ${className}`} data-closed-months>
      {line} {REOPEN_HINT}
    </p>
  );
}

/**
 * Samma rad, med månaderna lästa för den inloggade (serverkomponent). Används på sidor som
 * inte redan läser stängda månader.
 */
export async function ClosedMonthsBanner({ className }: { className?: string }) {
  const months = await loadClosedMonthKeysFor(await requireViewer());
  return <ClosedMonthsNote months={months} className={className} />;
}
