import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Statisk tabell för serverrenderade underlag (samma mått som DataTable: huvud 36 px,
 * rad 44 px, 1 px linjer). Bred tabell scrollar inuti sin egen yta.
 */
export function Table({
  caption,
  head,
  children,
  className,
}: {
  caption: string;
  head: ReadonlyArray<{ label: string; numeric?: boolean; hideOnMobile?: boolean }>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 overflow-x-auto", className)}>
      <table className="w-full border-collapse text-base">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="h-9 border-b border-line-strong">
            {head.map((h) => (
              <th
                key={h.label}
                scope="col"
                className={cn(
                  "label px-3 text-left font-normal whitespace-nowrap text-subtle first:pl-0 last:pr-0",
                  h.numeric && "text-right",
                  h.hideOnMobile && "hidden md:table-cell",
                )}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={cn("h-11 border-b border-line align-middle", className)}>{children}</tr>;
}

export function Cell({
  children,
  numeric,
  hideOnMobile,
  className,
  header,
}: {
  children: ReactNode;
  numeric?: boolean;
  hideOnMobile?: boolean;
  className?: string;
  /** Radens rubrikcell (th scope=row). */
  header?: boolean;
}) {
  const cls = cn(
    "px-3 py-2 first:pl-0 last:pr-0",
    numeric && "tnum text-right whitespace-nowrap",
    hideOnMobile && "hidden md:table-cell",
    header && "text-left font-normal",
    className,
  );
  return header ? (
    <th scope="row" className={cls}>
      {children}
    </th>
  ) : (
    <td className={cls}>{children}</td>
  );
}
