import Link from "next/link";

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
  /** Stegen när mer än en sak ska göras: "1. Räkna om. 2. Packa 2 omgångar." */
  readonly note?: string | null;
  /** Läget under titeln: "0 hemma · 9 i automaten · slut om 3 dagar". */
  readonly fact?: string | null;
  readonly href: string;
  /** Röd = måste göras nu, gul = snart. */
  readonly tone: "critical" | "warning";
}

/**
 * Saker att göra i ett V2-kort ("Att göra · 3"): en rad per sak med verbet i rött (måste
 * göras nu) eller gult (snart), titeln, läget i grått och antalet till höger. Tom lista:
 * grön bock och `done`.
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
      <p className="inline-flex items-center gap-2 text-v2-md text-v2-profit-text">
        <Icon name="check" size={16} />
        {done}
      </p>
    );
  }
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <section aria-label={label} className="v2-card">
      <div className="v2-card-hd">
        <h2>
          {label}
          <span aria-hidden="true">·</span>
          <span className="n">{formatInt(items.length)}</span>
        </h2>
      </div>
      <ul className="flex flex-col divide-y divide-v2-line2">
        {shown.map((t) => (
          <li key={t.key}>
            <Link
              href={t.href}
              className="flex min-h-14 items-center justify-between gap-3 px-[18px] py-2.5 transition-colors duration-150 hover:bg-v2-hover"
            >
              <span className="flex min-w-0 items-start gap-2.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "v2-dot mt-[7px] shrink-0",
                    t.tone === "critical" ? "critical" : "warning",
                  )}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-v2-md [overflow-wrap:anywhere] text-v2-ink">
                    <span
                      className={cn(
                        "font-[550]",
                        t.tone === "critical" ? "text-v2-crit-text" : "text-v2-warn-text",
                      )}
                    >
                      {t.verb}
                    </span>{" "}
                    {t.title}
                  </span>
                  {t.note ? (
                    <span className="text-v2-sm font-[550] text-v2-ink">{t.note}</span>
                  ) : null}
                  {t.fact ? <span className="tnum text-v2-sm text-v2-mute">{t.fact}</span> : null}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {t.qty !== undefined && t.qty !== null ? (
                  <span className="tnum text-v2-md font-[550] text-v2-ink">
                    {formatInt(t.qty)}
                    <span className="font-normal text-v2-mute">
                      {NBSP}
                      {t.unit ?? "st"}
                    </span>
                  </span>
                ) : null}
                <Icon name="chevronRight" size={14} className="text-v2-faint" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {rest > 0 ? (
        <div className="border-t border-v2-line2 px-[18px] py-2.5 text-v2-sm text-v2-mute">
          {moreHref ? (
            <Link href={moreHref} className="hover:text-v2-ink max-md:tap">
              +{NBSP}
              {formatInt(rest)} till
            </Link>
          ) : (
            <>
              +{NBSP}
              {formatInt(rest)} till
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
