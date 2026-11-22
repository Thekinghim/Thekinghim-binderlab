import Link from "next/link";

import { Badge } from "@/components/v2/badge";
import { formatInt, NBSP } from "@/lib/format";

/** En sak att packa (samma fält som Vårt lagers att göra-lista). */
export interface PackRow {
  readonly key: string;
  readonly verb: string;
  readonly title: string;
  readonly qty?: number | null;
  readonly unit?: string;
  readonly note?: string | null;
  readonly fact?: string | null;
  readonly href: string;
  /** Röd = måste göras nu, gul = snart. */
  readonly tone: "critical" | "warning";
}

/**
 * Att packa på Inköp (V2): en rad per titel i ett kort, verbet som märke (rött nu, gult snart),
 * läget under titeln och antalet till höger. Hela raden länkar (Mystery packs eller Vårt lager).
 */
export function PackRows({ items, max = 12 }: { items: readonly PackRow[]; max?: number }) {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <>
      <ul aria-label="Att packa">
        {shown.map((t) => (
          <li key={t.key} className="border-b border-v2-line2 last:border-b-0">
            <Link
              href={t.href}
              className="flex min-h-14 items-center justify-between gap-3 px-[18px] py-3 transition-colors duration-150 hover:bg-v2-hover max-[900px]:px-4"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge tone={t.tone}>{t.verb}</Badge>
                  <span className="truncate text-v2-md font-[550] text-v2-ink">{t.title}</span>
                </span>
                {t.note ? (
                  <span className="text-v2-sm font-[550] text-v2-ink">{t.note}</span>
                ) : null}
                {t.fact ? <span className="tnum text-v2-xs text-v2-mute">{t.fact}</span> : null}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {t.qty !== undefined && t.qty !== null ? (
                  <span className="tnum text-v2-xl font-[650] text-v2-ink">
                    {formatInt(t.qty)}
                    <span className="text-v2-sm font-[450] text-v2-mute">
                      {NBSP}
                      {t.unit ?? "st"}
                    </span>
                  </span>
                ) : null}
                <span aria-hidden className="text-v2-faint">
                  →
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {rest > 0 ? (
        <p className="border-t border-v2-line2 px-[18px] py-2.5 text-v2-xs text-v2-mute">
          {`+${NBSP}${formatInt(rest)} till`}
        </p>
      ) : null}
    </>
  );
}
