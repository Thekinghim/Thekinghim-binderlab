import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/cn";

import type { ValueCard, ValueRow, ValueView } from "../_lib/view";

function rise(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

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
    <nav aria-label="Välj månad" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <ul className="flex w-max gap-2">
        {months.map((m) => {
          const active = m.month === selected;
          return (
            <li key={m.month}>
              <Link
                href={`/varde?manad=${m.month}`}
                aria-current={active ? "page" : undefined}
                aria-label={label(m.month)}
                className={cn(
                  "inline-flex h-9 items-center rounded-sm border px-3 text-sm whitespace-nowrap transition-colors duration-fast ease-instrument",
                  active
                    ? "border-inverse bg-inverse text-on-inverse"
                    : "border-line-strong bg-surface text-fg hover:border-line-control hover:bg-hover",
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

/** De fyra korten: räddat, tid, kvar efter inköp och försäljning. */
export function ValueCards({ cards }: { cards: readonly ValueCard[] }) {
  return (
    <ul
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      aria-label="Sammanfattning"
    >
      {cards.map((c, i) => (
        <li
          key={c.id}
          data-card={c.id}
          className="rise flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface p-4 md:p-5"
          style={rise(i + 1)}
        >
          <span className="label text-muted">{c.label}</span>
          <span
            className={cn(
              "tnum text-2xl font-medium md:text-3xl",
              c.tone === "good" && "text-up",
              c.tone === "bad" && "text-signal-fg",
            )}
          >
            {c.value}
          </span>
          <span className="text-sm text-muted">{c.sub}</span>
        </li>
      ))}
    </ul>
  );
}

/** Bästa åtgärder: högst tre, med värde och länk. */
export function ActionList({ actions }: { actions: ValueView["actions"] }) {
  if (actions.length === 0) {
    return <p className="text-base text-muted">Inget att föreslå just nu. Bra jobbat.</p>;
  }
  return (
    <ol className="flex flex-col divide-y divide-line border-y border-line">
      {actions.map((a, i) => (
        <li key={a.key}>
          <Link
            href={a.href}
            className="group flex min-h-14 items-start gap-3 py-3 transition-colors duration-fast ease-instrument hover:bg-hover md:items-center md:px-2"
          >
            <span className="tnum label mt-0.5 w-5 shrink-0 text-subtle md:mt-0">{i + 1}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-base font-medium text-fg">{a.title}</span>
              <span className="text-sm text-muted">{a.detail}</span>
            </span>
            {a.valueText ? (
              <span className="tnum shrink-0 text-sm text-up">{a.valueText}</span>
            ) : null}
            <span aria-hidden className="shrink-0 text-subtle group-hover:text-fg">
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
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <table className="w-full min-w-[520px] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line">
            {head.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={cn(
                  "label py-2 font-normal text-muted",
                  i === 0 ? "pr-4 text-left" : "px-2 text-right",
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line">
              {r.cells.map((c, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="py-2 pr-4 text-left font-normal text-fg">
                    {c}
                  </th>
                ) : (
                  <td key={i} className="tnum px-2 py-2 text-right whitespace-nowrap text-fg">
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

/** Ett hopfällt block (stängt som standard): det mindre viktiga. */
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
    <details id={id} open={open} className="group border-t border-line">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 py-3 text-base text-fg [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="inline-block w-4 text-subtle transition-transform duration-fast group-open:rotate-90"
        >
          ›
        </span>
        <span className="font-medium">{title}</span>
        {meta ? <span className="tnum text-sm text-muted">· {meta}</span> : null}
      </summary>
      <div className="pb-6">{children}</div>
    </details>
  );
}
