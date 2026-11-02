import Link from "next/link";

import { wallClockIn } from "@/components/shell/period-state";
import { Panel } from "@/components/ui/frame";
import { StatusGlyph, StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatDateTime, formatDuration, formatInt, NBSP } from "@/lib/format";
import type { OnboardingStatus, OnboardingStep } from "@/server/onboarding/model";

/**
 * Checklistan i Kom igång. Status per steg räknas ur datan (src/server/onboarding), så
 * här finns inga kryssrutor: ett steg är klart när butiken, automaten, ordern eller
 * priset finns.
 *
 * - variant="full" (standard): alla steg med nummer, varför, läget i siffror, när steget
 *   blev klart och åtgärden. Används på /kom-igang.
 * - variant="compact": en panel med nästa steg och stegens nummer, för överst på Hem
 *   tills status.complete är sant. Länkar till /kom-igang.
 *
 * Bara ägare och admin får åtgärder (canEdit); läsaren ser läget. Serverkomponent utan
 * klientkod.
 *
 *   const status = await onboardingStatus(ctx.organization.id);
 *   {status.complete ? null : <OnboardingChecklist status={status} canEdit={ctx.canEdit}
 *     timeZone={ctx.timeZone} variant="compact" />}
 */
export function OnboardingChecklist({
  status,
  canEdit,
  timeZone,
  variant = "full",
  className,
}: {
  status: OnboardingStatus;
  canEdit: boolean;
  /** Organisationens tidszon (tider visas i den). */
  timeZone: string;
  variant?: "full" | "compact";
  className?: string;
}) {
  if (variant === "compact") {
    return (
      <CompactChecklist
        status={status}
        canEdit={canEdit}
        timeZone={timeZone}
        className={className}
      />
    );
  }
  const now = new Date(status.now);
  return (
    <ol aria-label="Steg" className={cn("flex flex-col border-b border-line", className)}>
      {status.steps.map((step) => (
        <StepRow
          key={step.id}
          step={step}
          primary={status.next?.id === step.id}
          canEdit={canEdit}
          timeZone={timeZone}
          now={now}
        />
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------

const STATE_TEXT = { done: "Klar", todo: "Att göra", waiting: "Väntar" } as const;

function StepRow({
  step,
  primary,
  canEdit,
  timeZone,
  now,
}: {
  step: OnboardingStep;
  primary: boolean;
  canEdit: boolean;
  timeZone: string;
  now: Date;
}) {
  const titleId = `steg-${step.id}`;
  const done = step.state === "done";
  return (
    <li
      aria-labelledby={titleId}
      className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 gap-y-4 border-t border-line py-6 md:grid-cols-[3rem_minmax(0,1fr)] lg:grid-cols-12 lg:gap-x-8"
    >
      <div className="flex flex-col gap-2 lg:col-span-1">
        <span className={cn("label tnum", done ? "text-subtle" : "text-fg")}>{step.number}</span>
      </div>

      <div className="flex min-w-0 flex-col gap-2 lg:col-span-7">
        <h3
          id={titleId}
          className={cn(
            "text-md font-medium text-balance hyphens-none",
            done ? "text-muted" : "text-fg",
          )}
        >
          {step.title}
          {!step.required ? <span className="text-subtle"> Rekommenderas.</span> : null}
        </h3>
        <p className="max-w-2xl text-sm text-muted">{step.why}</p>
        <p className="text-sm text-subtle">
          <span className="sr-only">Läge: </span>
          {step.detail}
          {step.waitingFor ? ` ${step.waitingFor}` : ""}
        </p>
      </div>

      <div className="col-start-2 flex min-w-0 flex-col items-start gap-3 lg:col-span-4 lg:col-start-auto lg:items-end lg:text-right">
        <StepState step={step} />
        {done && step.doneAt ? (
          <p className="meta tnum text-subtle">
            <time dateTime={step.doneAt}>{when(step.doneAt, timeZone, now)}</time>
            {step.sinceStartMs !== null && step.id !== "organisation"
              ? ` · efter ${formatDuration(step.sinceStartMs)}`
              : ""}
          </p>
        ) : null}
        {!done && canEdit && step.action ? (
          <StepLink
            href={step.action.href}
            emphasis={primary && step.state === "todo" ? "primary" : "secondary"}
            disabled={step.state === "waiting"}
          >
            {step.action.label}
          </StepLink>
        ) : null}
      </div>
    </li>
  );
}

function StepState({ step }: { step: OnboardingStep }) {
  if (step.state === "done") return <StatusTag status="ok">{STATE_TEXT.done}</StatusTag>;
  if (step.state === "waiting") return <StatusTag status="offline">{STATE_TEXT.waiting}</StatusTag>;
  return <StatusTag status="warning">{STATE_TEXT.todo}</StatusTag>;
}

function StepLink({
  href,
  emphasis,
  disabled,
  children,
}: {
  href: string;
  emphasis: "primary" | "secondary";
  disabled?: boolean;
  children: string;
}) {
  const base =
    "inline-flex h-9 items-center gap-1.5 rounded-sm border px-3.5 text-base font-medium whitespace-nowrap transition-[background-color,border-color,color] duration-fast ease-instrument";
  if (disabled) {
    // Väntar på ett tidigare steg: ingen länk, streckad kant bär läget.
    return (
      <span
        aria-disabled
        className={cn(base, "cursor-not-allowed border-dashed border-line-strong text-disabled")}
      >
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={cn(
        base,
        emphasis === "primary"
          ? "border-inverse bg-inverse text-on-inverse hover:border-inverse-hover hover:bg-inverse-hover"
          : "border-line-strong bg-surface text-fg hover:border-line-control hover:bg-hover",
      )}
    >
      {children}
      <span aria-hidden className="font-mono">
        →
      </span>
    </Link>
  );
}

function when(iso: string, timeZone: string, now: Date): string {
  return formatDateTime(wallClockIn(new Date(iso), timeZone), { now: wallClockIn(now, timeZone) });
}

// ---------------------------------------------------------------------------

function CompactChecklist({
  status,
  canEdit,
  className,
}: {
  status: OnboardingStatus;
  canEdit: boolean;
  timeZone: string;
  className?: string;
}) {
  const next = status.next;
  return (
    <Panel className={cn("flex flex-col gap-5", className)}>
      <section aria-labelledby="kom-igang-kort" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <p className="label text-muted">
            <span className="text-fg">Kom igång</span>
            <span className="text-faint"> / </span>
            {`${formatInt(status.requiredDone)} av ${formatInt(status.requiredTotal)} steg`}
          </p>
          <p className="meta tnum text-subtle">
            {status.complete
              ? `Klart på ${formatDuration(status.elapsedMs)}`
              : `Pågått ${formatDuration(status.elapsedMs)}`}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h2 id="kom-igang-kort" className="text-lg font-medium text-balance hyphens-none text-fg">
            {next ? (
              <>
                {`${next.number} ${next.title}`}
                <span className="text-subtle"> {next.detail}</span>
              </>
            ) : (
              "Panelen har det den behöver."
            )}
          </h2>
          {next ? <p className="max-w-2xl text-sm text-muted">{next.why}</p> : null}
        </div>

        <ol aria-label="Steg" className="flex flex-wrap gap-x-4 gap-y-2">
          {status.steps.map((s) => (
            <li key={s.id} className="label tnum inline-flex items-center gap-1.5 text-muted">
              <span className={cn("inline-flex", s.state === "done" ? "text-subtle" : "text-fg")}>
                <StatusGlyph
                  status={s.state === "done" ? "ok" : s.state === "waiting" ? "offline" : "warning"}
                  size={s.state === "done" ? 6 : 8}
                />
              </span>
              <span className={s.state === "done" ? "text-subtle" : "text-fg"}>{s.number}</span>
              <span className="sr-only">{`${s.title} ${STATE_TEXT[s.state]}.`}</span>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {next && canEdit && next.action ? (
            <StepLink href={next.action.href} emphasis="primary">
              {next.action.label}
            </StepLink>
          ) : null}
          <Link
            href="/kom-igang"
            className="meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
          >
            <span>{`Alla${NBSP}${formatInt(status.steps.length)} steg`}</span>
            <span aria-hidden className="text-subtle">
              →
            </span>
          </Link>
        </div>
      </section>
    </Panel>
  );
}
