import Link from "next/link";
import type { CSSProperties } from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

/** En sak att göra: verb ("Packa"), vad, eventuellt antal, och vart ett tryck leder. */
export interface TodoItem {
  readonly key: string;
  readonly verb: string;
  readonly title: string;
  readonly qty?: number | null;
  /** Enhet efter antalet (standard "st"). */
  readonly unit?: string;
  readonly href: string;
  /** Röd = måste göras nu, gul = snart. */
  readonly tone: "critical" | "warning";
}

/**
 * Listan under sidans stora siffra: en rad per sak att göra, stora tryckytor, rött för
 * det som måste göras nu. Tom lista: grön bock och `done`. Korten glider in i tur och
 * ordning (rise) och lyfter vid hover (lift).
 */
export function TodoList({
  items,
  done,
  label = "Att göra",
  max = 6,
  moreHref,
}: {
  items: readonly TodoItem[];
  /** Text när inget behöver göras, t.ex. "Allt räcker." */
  done: string;
  label?: string;
  /** Högst så många visas; resten som "+ 3 till". */
  max?: number;
  moreHref?: string;
}) {
  if (items.length === 0) {
    return (
      <p
        className="rise inline-flex items-center gap-2 text-base text-up"
        style={{ "--i": 1 } as CSSProperties}
      >
        <Icon name="check" size={16} />
        {done}
      </p>
    );
  }
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((t, i) => (
          <li key={t.key} className="rise" style={{ "--i": i + 1 } as CSSProperties}>
            <Link
              href={t.href}
              className={cn(
                "lift flex min-h-16 items-center justify-between gap-3 rounded-md border px-4 py-3",
                t.tone === "critical"
                  ? "border-signal-line bg-signal-soft"
                  : "border-line-strong bg-surface",
              )}
            >
              <span className="flex min-w-0 flex-col">
                <span
                  className={cn("label", t.tone === "critical" ? "text-signal-fg" : "text-subtle")}
                >
                  {t.verb}
                </span>
                <span className="truncate text-base text-fg">{t.title}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {t.qty !== undefined && t.qty !== null ? (
                  <span className="tnum text-2xl font-medium text-fg">
                    {formatInt(t.qty)}
                    <span className="text-base text-muted">
                      {NBSP}
                      {t.unit ?? "st"}
                    </span>
                  </span>
                ) : null}
                <Icon name="chevronRight" size={14} className="text-subtle" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {rest > 0 ? (
        moreHref ? (
          <Link href={moreHref} className="meta w-fit text-muted hover:text-fg">
            +{NBSP}
            {formatInt(rest)} till
          </Link>
        ) : (
          <p className="meta text-muted">
            +{NBSP}
            {formatInt(rest)} till
          </p>
        )
      ) : null}
    </section>
  );
}
