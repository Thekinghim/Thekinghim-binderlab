"use client";

import { useCountUp } from "@/lib/hooks/use-count-up";
import { cn } from "@/lib/cn";
import { formatDelta } from "@/lib/format";
import { Sparkline } from "@/components/charts/sparkline";

type KpiCardProps = {
  label: string;
  value: number;
  format: (v: number) => string;
  /** Förändring mot jämförelseperiod, 0.12 = +12 % */
  delta?: number;
  deltaLabel?: string;
  trend?: ReadonlyArray<number>;
  /** Kräver uppmärksamhet: signalmarkör + sparkline-punkt */
  alert?: boolean;
  /** Text som förklarar varför kortet larmar (visas, så status inte bara är färg) */
  alertText?: string;
  /** Större negativ förändring är bra (t.ex. svinn, stopptid) */
  invert?: boolean;
  className?: string;
};

/** Nyckeltal: siffran är huvudpersonen. Räknar upp vid värdebyte. */
export function KpiCard({
  label,
  value,
  format,
  delta,
  deltaLabel = "mot föregående period",
  trend,
  alert,
  alertText,
  invert,
  className,
}: KpiCardProps) {
  const shown = useCountUp(value);
  const good = delta === undefined ? undefined : invert ? delta < 0 : delta > 0;

  return (
    <article
      className={cn(
        "relative flex min-w-0 flex-col justify-between gap-5 rounded-md border bg-surface p-4 md:p-5",
        alert ? "border-signal/50" : "border-line",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="label truncate text-muted">{label}</h3>
        {alert ? (
          <span className="label flex items-center gap-1.5 text-signal-fg">
            <span aria-hidden className="size-1.5 bg-signal" />
            {alertText ?? "Avvikelse"}
          </span>
        ) : null}
      </header>

      <div className="flex flex-col gap-1">
        <p className="tnum text-2xl font-medium md:text-[36px] md:leading-[40px] md:tracking-[-0.03em]">
          {format(shown)}
        </p>
        {delta !== undefined ? (
          <p className="label tnum flex flex-wrap items-center gap-x-2 gap-y-0.5 text-subtle">
            <span className={cn("inline-flex items-center gap-1", good ? "text-fg" : "text-muted")}>
              <DeltaGlyph up={delta >= 0} />
              {formatDelta(delta, Math.abs(delta) < 0.1 ? 1 : 0)}
            </span>
            <span className="tracking-[0.04em] normal-case">{deltaLabel}</span>
          </p>
        ) : null}
      </div>

      {trend ? (
        <div className="-mx-1">
          <Sparkline data={trend} alert={alert} height={36} />
        </div>
      ) : null}
    </article>
  );
}

export function DeltaGlyph({ up }: { up: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
      <path d={up ? "M4 0.5 L7.5 7 L0.5 7Z" : "M4 7.5 L7.5 1 L0.5 1Z"} fill="currentColor" />
    </svg>
  );
}
