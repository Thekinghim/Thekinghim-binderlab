import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import type { ValueCard, ValueRow, ValueView } from "../_lib/view";

/** Månaderna som länkar (nyast först), vald månad markerad. Rullar i sidled på mobilen. */
export function MonthPicker({
  months,
  selected,
  label,
}: {
  months: ReadonlyArray<{ month: string; label: string }>;
  selected: string;
  label: (month: string) => string;
}) {
  return (
    <nav
      aria-label="Välj månad"
      className="-mx-3 [scrollbar-width:none] overflow-x-auto px-3 min-[901px]:mx-0 min-[901px]:px-0"
    >
      <ul className="flex w-max gap-1.5">
        {months.map((m) => {
          const active = m.month === selected;
          return (
            <li key={m.month}>
              <Link
                href={`/varde?manad=${m.month}`}
                aria-current={active ? "page" : undefined}
                aria-label={label(m.month)}
                className={cn(
                  "inline-flex h-8 items-center rounded-full border px-3 text-v2-sm font-[550] whitespace-nowrap transition-[background-color,transform] duration-150 active:scale-[0.97] max-[900px]:h-11",
                  active
                    ? "border-v2-primary bg-v2-primary text-[color:var(--v2-on-primary)]"
                    : "border-v2-line bg-v2-panel text-v2-ink hover:bg-v2-hover",
                )}
              >
                {m.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** De fyra talen (räddat, tid, kvar efter inköp och försäljning) som KPI-bandet på Hem. */
export function ValueCards({ cards }: { cards: readonly ValueCard[] }) {
  return (
    <div className="v2-band-wrap">
      <ul className="v2-band" aria-label="Sammanfattning">
        {cards.map((c) => (
          <li key={c.id} data-card={c.id} className="v2-kt pb-3.5">
            <span className="kl">{c.label}</span>
            <span
              className={cn(
                "kn tnum",
                c.tone === "good" && "text-v2-profit-text",
                c.tone === "bad" && "text-v2-crit-text",
              )}
            >
              {c.value}
            </span>
            <span className="kd">
              <span className="!whitespace-normal">{c.sub}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Bästa åtgärder: högst tre, med värde och länk. */
export function ActionList({ actions }: { actions: ValueView["actions"] }) {
  if (actions.length === 0) {
    return <p className="v2-empty">Inget att föreslå just nu. Bra jobbat.</p>;
  }
  return (
    <ol className="flex flex-col">
      {actions.map((a, i) => (
        <li key={a.key} className="group">
          <Link
            href={a.href}
            className="group flex min-h-14 items-start gap-3 border-b border-v2-line2 px-[18px] py-3 transition-colors duration-150 group-last:border-b-0 hover:bg-v2-hover md:items-center"
          >
            <span className="tnum mt-0.5 w-5 shrink-0 text-v2-sm text-v2-mute md:mt-0">
              {i + 1}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-v2-md font-[550] text-v2-ink">{a.title}</span>
              <span className="text-v2-sm text-v2-mute">{a.detail}</span>
            </span>
            {a.valueText ? (
              <span className="tnum shrink-0 text-v2-sm font-[550] text-v2-profit-text">
                {a.valueText}
              </span>
            ) : null}
            <span aria-hidden className="shrink-0 text-v2-faint group-hover:text-v2-ink">
              →
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

/** En enkel tabell; första kolumnen text, resten tal till höger. Rullar i sidled vid behov. */
export function ValueTable({
  head,
  rows,
  caption,
  empty,
}: {
  head: readonly string[];
  rows: readonly ValueRow[];
  caption: string;
  empty: string;
}) {
  if (rows.length === 0) return <p className="v2-empty">{empty}</p>;
  return (
    <div className="v2-table-wrap">
      <table className="v2-table min-w-[520px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={i === 0 ? undefined : "num"}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((c, i) =>
                i === 0 ? (
                  <th
                    key={i}
                    scope="row"
                    className="h-auto border-b-v2-line2 bg-transparent py-2.5 text-left text-v2-sm font-[450] text-v2-ink"
                  >
                    {c}
                  </th>
                ) : (
                  <td key={i} className="num whitespace-nowrap">
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Ett hopfällt block (stängt som standard): det mindre viktiga, som en rad i ett kort. */
export function Fold({
  title,
  meta,
  children,
  id,
  open,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
  id: string;
  open?: boolean;
}) {
  return (
    <details id={id} open={open} className="group border-b border-v2-line2 last:border-b-0">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-[18px] py-3 text-v2-md text-v2-ink transition-colors duration-150 hover:bg-v2-hover [&::-webkit-details-marker]:hidden">
        <span className="font-[550]">{title}</span>
        {meta ? <span className="tnum text-v2-sm text-v2-mute">{meta}</span> : null}
        <span
          aria-hidden
          className="ml-auto inline-block text-v2-faint transition-transform duration-150 group-open:rotate-90"
        >
          ›
        </span>
      </summary>
      <div className="pb-4">{children}</div>
    </details>
  );
}
