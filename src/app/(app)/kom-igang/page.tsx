import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { wallClockIn } from "@/components/shell/period-state";
import { homeHref } from "@/components/shell/nav";
import { SectionHeader, type SectionMeta } from "@/components/ui/section-header";
import { formatDateTime, formatDuration, formatInt, MISSING } from "@/lib/format";
import { loadContext } from "@/server/data/core";
import { canSeeOnboarding, onboardingStatus } from "@/server/onboarding";
import { coverageText } from "@/server/onboarding/model";

import { OnboardingChecklist } from "./_components/onboarding-checklist";

export const metadata: Metadata = { title: "Kom igång" };

/**
 * Kom igång: checklistan för en ny organisation. Varje steg är klart när datan finns
 * (butik, automat, datakälla, import med order, inköpspris för minst 90 % av intäkten),
 * och tiden från att organisationen skapades till varje steg står vid steget.
 *
 * Ägare, admin och läsare (läsaren ser läget men inga åtgärder). Påfyllaren skickas till
 * sin startsida. Statusen räknas i src/server/onboarding.
 */
export default async function KomIgangPage() {
  const ctx = await loadContext();
  if (!canSeeOnboarding(ctx.role)) redirect(homeHref(ctx.role));
  const status = await onboardingStatus(ctx.organization.id);
  const now = new Date(status.now);
  const at = (iso: string) =>
    formatDateTime(wallClockIn(new Date(iso), ctx.timeZone), {
      now: wallClockIn(now, ctx.timeZone),
    });

  const remaining = status.requiredTotal - status.requiredDone;
  // Data som lades in på en gång (seed, exempeldata) säger inget om hur lång tid
  // onboarding tar: då visas ingen tid, bara att panelen har det den behöver.
  const title = status.complete
    ? status.loadedAtOnce
      ? "Panelen har det den behöver."
      : `Klart på ${formatDuration(status.elapsedMs)}.`
    : `${formatInt(status.requiredDone)} av ${formatInt(status.requiredTotal)} nödvändiga steg klara.`;
  const aside = status.complete
    ? status.loadedAtOnce
      ? `Alla ${formatInt(status.requiredTotal)} nödvändiga steg är gjorda.`
      : `Alla ${formatInt(status.requiredTotal)} nödvändiga steg är gjorda.`
    : `${formatInt(remaining)} kvar, ${formatDuration(status.elapsedMs)} sedan start.`;
  const nextTitle = status.next?.title.replace(/\.$/, "");
  const description = status.complete
    ? undefined
    : status.next
      ? ctx.canEdit
        ? `Nästa: ${nextTitle}. ${status.next.why}`
        : `Väntar på steg ${status.next.number}: ${nextTitle?.toLowerCase()}.`
      : undefined;

  const meta: SectionMeta[] = [
    { label: "Start", value: at(status.startedAt) },
    status.completedAt
      ? { label: "Klart", value: at(status.completedAt) }
      : { label: "Pågått", value: formatDuration(status.elapsedMs) },
    {
      label: "Med inköpspris",
      value:
        status.coverage.pricedShareBp === null
          ? MISSING
          : coverageText(status.coverage.pricedShareBp),
    },
  ];

  const stepsDone = status.steps.filter((s) => s.state === "done").length;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:gap-12 md:px-8 md:pt-12">
      <SectionHeader
        className="rise"
        as="h1"
        size="xl"
        eyebrow={`Kom igång · ${ctx.organization.name}`}
        title={title}
        aside={aside}
        description={description}
        meta={meta}
      />

      <section
        aria-labelledby="steg"
        className="rise flex flex-col gap-8"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <SectionHeader
          id="steg"
          size="md"
          title="Steg."
          aside={`${formatInt(stepsDone)} av ${formatInt(status.steps.length)} klara.`}
          actions={
            status.complete ? (
              <Link
                href="/"
                className="meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-muted underline-offset-4 transition-colors hover:text-fg hover:underline max-md:tap max-md:min-h-11"
              >
                <span>Till Hem</span>
                <span aria-hidden className="text-subtle">
                  →
                </span>
              </Link>
            ) : undefined
          }
        />
        <OnboardingChecklist status={status} canEdit={ctx.canEdit} timeZone={ctx.timeZone} />
      </section>
    </div>
  );
}
