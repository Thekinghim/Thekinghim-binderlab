import Link from "next/link";

import { cn } from "@/lib/cn";
import type { MachineReadiness, ReadyStep } from "@/server/onboarding/machine-ready";

/**
 * Startklar: vad som är kvar innan en ny automat är helt inlagd (src/server/onboarding/
 * machine-ready.ts). Rubriken säger hur långt det har kommit och vad som är nästa sak; varje
 * rad som går att göra är en länk till rätt formulär. Visas inte när allt är klart.
 * Serverkomponent utan klientkod. Bara ägare och admin får länkar (canEdit).
 */
export function ReadyList({ ready, canEdit }: { ready: MachineReadiness; canEdit: boolean }) {
  if (ready.complete) return null;
  const next = ready.next;
  return (
    <section
      aria-labelledby="startklar"
      data-startklar={ready.code}
      className="rise flex flex-col gap-4 rounded-md border border-line-control bg-surface px-4 py-4"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="label text-subtle">Startklar</span>
          <h2 id="startklar" className="text-md font-medium text-balance text-fg">
            {`${ready.code}: ${ready.progress}.`}
          </h2>
          {next ? <p className="text-sm text-muted">{`Nästa: ${next.next}.`}</p> : null}
        </div>
        {canEdit && next?.href ? (
          <Link
            href={next.href}
            className="inline-flex h-9 w-fit shrink-0 items-center rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse hover:bg-inverse-hover max-md:min-h-11"
          >
            {capital(next.next)}
          </Link>
        ) : null}
      </div>
      <ol className="flex flex-col divide-y divide-line border-t border-line">
        {ready.steps.map((step) => (
          <Step key={step.id} step={step} canEdit={canEdit} />
        ))}
      </ol>
    </section>
  );
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Step({ step, canEdit }: { step: ReadyStep; canEdit: boolean }) {
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-xs border text-xs",
          step.done
            ? "border-line-strong bg-hover text-fg"
            : "border-line-control text-transparent",
        )}
      >
        ✓
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("text-md", step.done ? "text-muted" : "font-medium text-fg")}>
          <span className="sr-only">{step.done ? "Klart: " : "Kvar: "}</span>
          {step.label}
        </span>
        {step.detail ? <span className="text-sm text-muted">{step.detail}</span> : null}
      </span>
    </>
  );
  const row = "flex min-h-11 items-start gap-3 py-2.5";
  if (!step.done && canEdit && step.href) {
    return (
      <li>
        <Link href={step.href} className={cn(row, "rounded-xs hover:bg-hover")}>
          {body}
          <span aria-hidden className="mt-0.5 shrink-0 text-subtle">
            →
          </span>
        </Link>
      </li>
    );
  }
  return <li className={row}>{body}</li>;
}
