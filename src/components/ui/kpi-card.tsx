"use client";

import { cn } from "@/lib/cn";
import { CountUp } from "./count-up";
import { KpiTrace } from "./kpi-trace";
import {
  KpiAlert,
  KpiDelta,
  useKpiValue,
  useValueFade,
  type KpiDeltaKind,
  type KpiMotion,
} from "./kpi-parts";

export { DeltaGlyph } from "./kpi-parts";

type KpiCardProps = {
  label: string;
  value: number;
  format: (v: number) => string;
  /** Förändring mot jämförelseperiod. relative: 0.12 = +12 %. absolute: i värdets enhet. */
  delta?: number;
  deltaKind?: KpiDeltaKind;
  /** Enhet för absolut delta, t.ex. "st" */
  deltaUnit?: string;
  /** Jämförelsetext efter deltat. Tom sträng döljer den (när perioden står i rubriken). */
  deltaLabel?: string;
  trend?: ReadonlyArray<number>;
  /** Jämförelseperiodens snitt: streckad hjälplinje i trenden */
  reference?: number;
  /** Kräver åtgärd: signalkvadrat + text, signalnod i trenden. Ingen signalkant. */
  alert?: boolean;
  /** Text som förklarar varför kortet larmar, t.ex. "Gräns 3 st" (status är aldrig bara färg) */
  alertText?: string;
  /** Minskning är bra (t.ex. tomma fack, svinn, stopptid) */
  invert?: boolean;
  /**
   * panel: egen 1px kant (fristående nyckeltal). bare: ingen kant.
   * Inuti en Panel släpps kanten automatiskt. Flera nyckeltal i rad: använd KpiStrip.
   */
  variant?: "panel" | "bare";
  /** Visning vid värdebyte. Standard: räkna upp (heltal från 0 vid visning). */
  motion?: KpiMotion;
  className?: string;
};

/** Ett fristående nyckeltal. Siffran är huvudpersonen. */
export function KpiCard({
  label,
  value,
  format,
  delta,
  deltaKind,
  deltaUnit,
  deltaLabel = "mot föregående period",
  trend,
  reference,
  alert,
  alertText,
  invert,
  variant = "panel",
  motion = "count",
  className,
}: KpiCardProps) {
  // Heltal räknas upp från 0 när kortet visas; övriga från föregående värde.
  const countUp = motion === "count" && Number.isInteger(value);
  const shown = useKpiValue(value, countUp ? "none" : motion);
  const ref = useValueFade<HTMLParagraphElement>(format(value), motion === "fade");

  return (
    <article
      className={cn(
        "relative flex min-w-0 flex-col gap-4",
        variant === "panel" &&
          "lift rounded-md border border-line bg-surface p-4 in-data-[frame=panel]:rounded-none in-data-[frame=panel]:border-0 in-data-[frame=panel]:bg-transparent in-data-[frame=panel]:p-0 md:p-5 md:in-data-[frame=panel]:p-0",
        className,
      )}
    >
      <h3 className="label truncate text-muted">{label}</h3>

      <div className="flex flex-col gap-1">
        <p ref={ref} className="tnum truncate text-xl font-medium sm:text-2xl">
          {countUp ? <CountUp value={value} format={format} /> : format(shown)}
        </p>
        {delta !== undefined ? (
          <KpiDelta
            spec={{ delta, kind: deltaKind, unit: deltaUnit, invert }}
            label={deltaLabel || undefined}
          />
        ) : null}
        {alert ? <KpiAlert className="mt-1">{alertText ?? "Kräver åtgärd"}</KpiAlert> : null}
      </div>

      {trend ? <KpiTrace data={trend} reference={reference} alert={alert} height={32} /> : null}
    </article>
  );
}
