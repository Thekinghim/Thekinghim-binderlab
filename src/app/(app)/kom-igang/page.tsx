import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { wallClockIn } from "@/components/shell/period-state";
import { homeHref } from "@/components/shell/nav";
import type { SectionMeta } from "@/components/ui/section-header";
import { Card, CardBody } from "@/components/v2/card";
import { KeyValues } from "@/components/v2/key-values";
import { Notice } from "@/components/v2/notice";
import { V2Page } from "@/components/v2/shell/page";
import { formatDateTime, formatDuration, formatInt, MISSING } from "@/lib/format";
import { loadContext } from "@/server/data/core";
import { canSeeOnboarding, onboardingStatus } from "@/server/onboarding";
import { coverageText } from "@/server/onboarding/model";

import "@/app/(app)/installningar/_components/settings.css";

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
    <V2Page
      title="Kom igång"
      sub={
        <>
          <b>{title}</b> {aside}
        </>
      }
    >
      <div className="v2-cols">
        <div className="v2-stack">
          {description ? <Notice tone="info">{description}</Notice> : null}
          <Card
            title={<span id="steg">Steg</span>}
            actions={
              status.complete ? (
                <Link href="/" className="lk">
                  Till Hem <span aria-hidden>→</span>
                </Link>
              ) : (
                <span className="lk tabular-nums">
                  {formatInt(stepsDone)} av {formatInt(status.steps.length)} klara
                </span>
              )
            }
          >
            <OnboardingChecklist status={status} canEdit={ctx.canEdit} timeZone={ctx.timeZone} />
          </Card>
        </div>
        <div className="v2-stack">
          <Card title={ctx.organization.name}>
            <CardBody>
              <KeyValues items={meta.map((m) => ({ label: m.label, value: m.value }))} />
            </CardBody>
          </Card>
        </div>
      </div>
    </V2Page>
  );
}
