"use client";

import type { ReactNode } from "react";

import { CountUp } from "@/components/ui/count-up";
import { cn } from "@/lib/cn";

import type { HomeHeadline } from "./headline";
import { kr } from "./text";

const TONE: Record<NonNullable<HomeHeadline["figure"]>["tone"], string> = {
  good: "text-up",
  bad: "text-signal-fg",
  neutral: "text-fg",
};

/**
 * Hems rubrik: det stora talet (vinsten, räknas upp), delningen på raden under och en kort
 * rad som hindrar misstag. Utan tal: rubrikens text som vanlig rubrik.
 */
export function HemHero({
  headline,
  eyebrow,
  children,
}: {
  headline: HomeHeadline;
  eyebrow: string;
  /**
   * Under raden, t.ex. AI-knappen. Under md står de i en "⋯"-meny uppe till höger (se
   * page.tsx), så rubriken lämnar plats åt den.
   */
  children?: ReactNode;
}) {
  const { figure, split } = headline;
  // Under md står "Hem" redan i underfliken; etiketten visas bara med ett filter.
  const scoped = eyebrow.includes("·");
  return (
    <header className="relative flex min-w-0 flex-col gap-3 max-md:gap-2">
      <p className={cn("label text-subtle", !scoped && "max-md:hidden")}>{eyebrow}</p>
      {figure ? (
        <h1
          aria-label={headline.title}
          className={cn(
            "text-3xl font-medium text-balance hyphens-none max-md:text-2xl lg:text-display lg:leading-[1.05]",
            children ? "max-md:pr-12" : null,
          )}
        >
          <span aria-hidden className="text-fg">
            {`${figure.label} `}
            <CountUp
              id="hem-vinst"
              value={figure.valueOre}
              format={kr}
              className={cn("tnum", TONE[figure.tone])}
            />
            <span className="text-subtle">{` ${figure.tail}`}</span>
          </span>
        </h1>
      ) : (
        <h1
          className={cn(
            "text-2xl font-medium text-balance lg:text-3xl",
            children ? "max-md:pr-12" : null,
          )}
        >
          <span className="text-fg">{headline.title}</span>
          {headline.aside ? <span className="text-subtle"> {headline.aside}</span> : null}
        </h1>
      )}
      {figure ? (
        <p className="tnum text-base text-muted sm:text-lg md:text-xl">
          {split.length > 0 ? (
            split.map((p, i) => (
              <span key={p.label}>
                {i > 0 ? <span className="text-subtle"> · </span> : null}
                {`${p.label} `}
                <CountUp id={`hem-del-${i}`} value={p.valueOre} format={kr} className="text-fg" />
                {i === split.length - 1 ? "." : null}
              </span>
            ))
          ) : (
            <span>{headline.aside}</span>
          )}
        </p>
      ) : null}
      {headline.lead.length > 0 ? (
        <p className="meta text-subtle">{headline.lead.join(" ")}</p>
      ) : null}
      {children}
    </header>
  );
}
