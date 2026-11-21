import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { HeaderTools } from "./header-tools";
import { V2Logo } from "./nav-icon";

/**
 * Sidramen för en V2-sida: rubrik + datum, Uppdaterad, sök, Assistenten och (valfritt)
 * periodvalet, en rad under rubriken ("8 behöver påfyllning · 2 offline") och innehållet.
 * Med data-v2-page döljer skalet de gamla sidornas huvud (brödsmulor, filter, underflikar).
 * Sidbytet tonar in 6 px uppifrån (bara tona vid reducerad rörelse).
 *
 * Serverkomponent: rubrik och text kommer från sidan, verktygen är klientdelar.
 */
export function V2Page({
  title,
  date,
  sub,
  period = false,
  tools,
  children,
  className,
}: {
  title: ReactNode;
  /** "lördag 21 november" (sidan formaterar i organisationens tidszon). */
  date?: ReactNode;
  /** Raden under rubriken. */
  sub?: ReactNode;
  /** Visa periodvalet 30 dagar / 7 dagar / I dag (?period). */
  period?: boolean;
  /** Egna verktyg före sök och periodval (t.ex. en knapp). */
  tools?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-v2-page className={cn("v2-enter", className)}>
      <header className="v2-top">
        <h1>
          <span className="mlogo" aria-hidden="true">
            <V2Logo size={24} />
          </span>
          {title}
          {date ? <span className="date">{date}</span> : null}
        </h1>
        <div className="flex min-w-0 items-center gap-2">
          {tools}
          <HeaderTools period={period} />
        </div>
      </header>
      {sub ? <div className="v2-sub">{sub}</div> : null}
      <div className="v2-page-body">{children}</div>
    </div>
  );
}

/** "lördag 21 november" i tidszonen (sidhuvudets datum). */
export function headerDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone,
  }).format(now);
}
