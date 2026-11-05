import Link from "next/link";

import { monthName } from "@/analytics/todos/text";
import { requireViewer } from "@/server/data/core";
import { loadValueTeaserFor } from "@/server/varde/load";

import { hoursText } from "../varde/_lib/view";

/**
 * Litet kort på Hem (ägare och admin): sparad tid hittills i månaden och en länk till
 * "Vad Binderlab gett dig" (/varde). Läser bara antal uppgifter (en fråga). Visas inte
 * alls om något går fel: kortet är en genväg, inte en siffra någon ska lita på här.
 */
export async function VardeCard({ className }: { className?: string }) {
  const teaser = await requireViewer()
    .then((v) => loadValueTeaserFor(v))
    .catch(() => null);
  if (!teaser) return null;
  const text =
    teaser.minutes > 0
      ? `Binderlab har sparat ${hoursText(teaser.minutes)} åt dig i ${monthName(teaser.month)}.`
      : "Se vad Binderlab gett dig, månad för månad.";
  return (
    <Link
      href="/varde"
      data-testid="varde-card"
      className={`group flex min-h-12 items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3 transition-colors duration-fast ease-instrument hover:bg-hover ${className ?? ""}`}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="label text-muted">Vad Binderlab gett dig</span>
        <span className="text-base text-fg">{text}</span>
      </span>
      <span aria-hidden className="shrink-0 text-subtle group-hover:text-fg">
        →
      </span>
    </Link>
  );
}
