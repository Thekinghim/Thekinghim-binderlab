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
  /** Under raden, t.ex. AI-knappen. */
  children?: ReactNode;
}) {
  const { figure, split } = headline;
  return (
    <header className="flex min-w-0 flex-col gap-3">
      <p className="label text-subtle">{eyebrow}</p>
      {figure ? (
        <h1
          aria-label={headline.title}
          className="text-3xl font-medium text-balance hyphens-none lg:text-display lg:leading-[1.05]"
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
        <h1 className="text-2xl font-medium text-balance lg:text-3xl">
          <span className="text-fg">{headline.title}</span>
          {headline.aside ? <span className="text-subtle"> {headline.aside}</span> : null}
        </h1>
      )}
      {figure ? (
        <p className="tnum text-lg text-muted md:text-xl">
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
