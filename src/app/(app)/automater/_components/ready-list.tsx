import Link from "next/link";

import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { cn } from "@/lib/cn";
import type { MachineReadiness, ReadyStep } from "@/server/onboarding/machine-ready";

/**
 * Startklar: vad som är kvar innan en ny automat är helt inlagd (src/server/onboarding/
 * machine-ready.ts). Rubriken säger hur långt det har kommit och vad som är nästa sak; varje
 * rad som går att göra är en länk till rätt formulär. Visas inte när allt är klart.
 * Serverkomponent utan klientkod. Bara ägare och admin får länkar (canEdit).
 * V2-kort; stegen bockas av som i Polaris checklista (fylld rund bock, streckad ring kvar).
 */
export function ReadyList({ ready, canEdit }: { ready: MachineReadiness; canEdit: boolean }) {
  if (ready.complete) return null;
  const next = ready.next;
  return (
    <div data-startklar={ready.code}>
      <Card
        title="Startklar"
        actions={
          canEdit && next?.href ? (
            <ButtonLink href={next.href} variant="act" size="sm" touch>
              {capital(next.next)}
            </ButtonLink>
          ) : undefined
        }
      >
        <div className="flex min-w-0 flex-col gap-1 border-b border-v2-line2 px-[18px] py-3.5 max-[900px]:px-4">
          <h3 className="text-v2-md font-[550] text-balance text-v2-ink">
            {`${ready.code}: ${ready.progress}.`}
          </h3>
          {next ? <p className="text-v2-sm text-v2-mute">{`Nästa: ${next.next}.`}</p> : null}
        </div>
        <ol className="flex flex-col">
          {ready.steps.map((step) => (
            <Step key={step.id} step={step} canEdit={canEdit} />
          ))}
        </ol>
      </Card>
    </div>
  );
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Bocken: fylld mörk ring med vit bock när steget är klart, streckad grå ring när det är kvar. */
function Check({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-full",
        done ? "bg-v2-ink text-v2-panel" : "border border-dashed border-v2-faint",
      )}
    >
      {done ? (
        <svg viewBox="0 0 12 12" className="size-2.5" fill="none">
          <path
            d="M2.5 6.2 4.9 8.5 9.5 3.6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  );
}

function Step({ step, canEdit }: { step: ReadyStep; canEdit: boolean }) {
  const body = (
    <>
      <Check done={step.done} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-v2-sm", step.done ? "text-v2-mute" : "font-[550] text-v2-ink")}>
          <span className="sr-only">{step.done ? "Klart: " : "Kvar: "}</span>
          {step.label}
        </span>
        {step.detail ? <span className="text-v2-xs text-v2-mute">{step.detail}</span> : null}
      </span>
    </>
  );
  const row = "flex min-h-11 items-start gap-3 px-[18px] py-3 max-[900px]:px-4";
  const line = "border-b border-v2-line2 last:border-b-0";
  if (!step.done && canEdit && step.href) {
    return (
      <li className={line}>
        <Link
          href={step.href}
          className={cn(
            row,
            "transition-colors [@media(hover:hover)_and_(pointer:fine)]:hover:bg-v2-hover",
          )}
        >
          {body}
          <span aria-hidden="true" className="mt-px shrink-0 text-v2-faint">
            →
          </span>
        </Link>
      </li>
    );
  }
  return <li className={cn(row, line)}>{body}</li>;
}
