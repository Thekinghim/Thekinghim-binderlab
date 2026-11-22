import Link from "next/link";

import { wallClockIn } from "@/components/shell/period-state";
import { Panel } from "@/components/ui/frame";
import { StatusGlyph } from "@/components/ui/status-tag";
import { Badge } from "@/components/v2/badge";
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
    <ol aria-label="Steg" className={cn("st-list", className)}>
      {status.steps.map((step) => (
        <StepRow
          key={step.id}
          step={step}
          primary={status.next?.id === step.id}
          canEdit={canEdit}
          timeZone={timeZone}
          now={now}
          showElapsed={!status.loadedAtOnce}
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
  showElapsed,
}: {
  step: OnboardingStep;
  primary: boolean;
  canEdit: boolean;
  timeZone: string;
  now: Date;
  /** Visa "efter X min" (inte när datan lades in på en gång). */
  showElapsed: boolean;
}) {
  const titleId = `steg-${step.id}`;
  const done = step.state === "done";
  return (
    <li
      aria-labelledby={titleId}
      className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-3 !py-4 lg:grid-cols-[2rem_minmax(0,1fr)_auto] lg:gap-x-6"
    >
      <div className="pt-px">
        <span
          aria-hidden
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-full text-v2-xs font-[650] tabular-nums",
            done
              ? "bg-v2-profit-soft text-v2-profit-text"
              : "bg-v2-hover text-v2-ink shadow-[0_0_0_1px_var(--v2-line)]",
          )}
        >
          {step.number}
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <h3
          id={titleId}
          className={cn(
            "text-v2-md font-[650] text-balance hyphens-none",
            done ? "text-v2-mute" : "text-v2-ink",
          )}
        >
          {step.title}
          {!step.required ? <span className="text-subtle"> Rekommenderas.</span> : null}
        </h3>
        <p className="max-w-2xl text-v2-sm text-v2-mute">{step.why}</p>
        <p className="text-v2-sm text-v2-faint">
          <span className="sr-only">Läge: </span>
          {step.detail}
          {step.waitingFor ? ` ${step.waitingFor}` : ""}
        </p>
      </div>

      <div className="col-start-2 flex min-w-0 flex-row flex-wrap items-center gap-2 lg:col-start-auto lg:flex-col lg:items-end lg:text-right">
        <StepState step={step} />
        {done && step.doneAt ? (
          <p className="text-v2-xs text-v2-mute tabular-nums">
            <time dateTime={step.doneAt}>{when(step.doneAt, timeZone, now)}</time>
            {showElapsed && step.sinceStartMs !== null && step.id !== "organisation"
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
  if (step.state === "done") return <Badge tone="success">{STATE_TEXT.done}</Badge>;
  if (step.state === "waiting") return <Badge>{STATE_TEXT.waiting}</Badge>;
  return <Badge tone="warning">{STATE_TEXT.todo}</Badge>;
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
  if (disabled) {
    // Väntar på ett tidigare steg: ingen länk, streckad kant bär läget. role="link" med
    // aria-disabled så att skärmläsaren läser den som en länk som inte går att följa.
    return (
      <span
        role="link"
        aria-disabled="true"
        className="v2-btn touch cursor-not-allowed border border-dashed border-v2-line text-v2-faint shadow-none"
      >
        {children}
        <span className="sr-only"> (väntar på ett tidigare steg)</span>
      </span>
    );
  }
  return (
    <Link href={href} className={cn("v2-btn touch", emphasis === "primary" && "act")}>
      {children}
      <span aria-hidden>→</span>
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
            <span aria-hidden className="text-faint">
              {" · "}
            </span>
            <span className="sr-only">: </span>
            {`${formatInt(status.requiredDone)} av ${formatInt(status.requiredTotal)} nödvändiga`}
          </p>
          <p className="meta tnum text-subtle">
            {status.complete
              ? status.loadedAtOnce
                ? "Klart"
                : `Klart på ${formatDuration(status.elapsedMs)}`
              : `Pågått ${formatDuration(status.elapsedMs)}`}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h2
            id="kom-igang-kort"
            className="text-v2-lg font-[650] text-balance hyphens-none text-v2-ink"
          >
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
            className="meta inline-flex min-h-7 items-center gap-1.5 rounded-xs text-muted underline-offset-4 transition-colors hover:text-fg hover:underline max-md:tap max-md:min-h-11"
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
