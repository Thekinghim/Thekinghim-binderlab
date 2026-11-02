"use client";

import { cn } from "@/lib/cn";
import { Skeleton } from "./skeleton";
import { KpiTrace } from "./kpi-trace";
import {
  KpiAlert,
  KpiDelta,
  useKpiValue,
  useValueFade,
  type KpiDeltaSpec,
  type KpiMotion,
} from "./kpi-parts";

export type KpiItem = {
  id: string;
  label: string;
  value: number;
  format: (v: number) => string;
  /** Förändring mot jämförelseperioden (som står en gång i remsans huvud) */
  delta?: KpiDeltaSpec;
  /** Egen dagsserie för perioden. Ritas som 1px linje utan fyllning. */
  trend?: ReadonlyArray<number>;
  /** Jämförelseperiodens snitt: streckad hjälplinje i trenden */
  reference?: number;
  /** Huvudpersonen: spänner två kolumner och får största talet. Högst en per remsa. */
  primary?: boolean;
  /** Kräver åtgärd. Ange alltid alertText, t.ex. "Gräns 3 st". */
  alert?: boolean;
  alertText?: string;
};

type KpiStripProps = {
  items: ReadonlyArray<KpiItem>;
  /** Remsans etikett, t.ex. "Nyckeltal · 30 dagar" */
  label?: string;
  /** Skrivs en gång, t.ex. "Jämfört med 3 sep. – 2 okt." */
  comparison?: string;
  loading?: boolean;
  motion?: KpiMotion;
  className?: string;
};

// Statiska klasser så att Tailwind hittar dem.
const lgCols: Record<number, string> = {
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
  7: "lg:grid-cols-7",
};
const smCols: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
};
/** Vilka celler som står först i sin rad vid `cols` kolumner (för att ta bort vänsterluften). */
function rowStarts(spans: ReadonlyArray<number>, cols: number): boolean[] {
  let col = 0;
  return spans.map((span) => {
    const s = Math.min(span, cols);
    if (col + s > cols) col = 0;
    const first = col === 0;
    col = (col + s) % cols;
    return first;
  });
}

/*
 * I en panel (data-frame="panel" på föräldern): remsans linje överst
 * utelämnas när den står först utan eget huvud, och linjen underst när
 * den står sist; panelens kant ligger redan där. I en panel med padding
 * går remsan då ut till kanten så att avdelarna möter ramen. Inre paneler
 * (som saknar sidopadding och bottenpadding) får ingen sådan utfallning.
 */
const firstInPanel =
  "[[data-frame=panel][data-padded]>&:first-child]:-mt-4 md:[[data-frame=panel][data-padded]>&:first-child]:-mt-5";
const lastInPanel =
  "[[data-frame=panel][data-padded]>&:last-child]:-mb-4 md:[[data-frame=panel][data-padded]>&:last-child]:-mb-5";
/** På linjeelementet (barn till section). */
const lineFirstInPanel = "[[data-frame=panel]>:first-child>&]:border-t-0";
const lineLastInPanel = "[[data-frame=panel]>:last-child>&]:border-b-0";
const nestedReset = "[[data-frame=panel]_[data-frame=panel]>&]:my-0";

const smSpan: Record<number, string> = {
  1: "sm:col-span-1",
  2: "sm:col-span-2",
  3: "sm:col-span-3",
  4: "sm:col-span-4",
};

/**
 * Nyckeltalsremsa: en sammanhängande rad utan kortramar, delad av 1px
 * linjer. Huvudpersonen (primary) spänner två kolumner och får det största
 * talet. Jämförelseperioden skrivs en gång i huvudet; cellerna visar bara
 * delta med riktning.
 *
 * Brytpunkter: under 640 px 2 × 2 utan trendlinjer; 640–1023 px står
 * huvudpersonen på egen rad med övriga under; från 1024 px en rad.
 *
 * Linjering: cellen som står först i sin rad har ingen vänsterluft, så att
 * huvudet, första kolumnens siffror och omgivande rubriker linjerar.
 */
export function KpiStrip({
  items,
  label,
  comparison,
  loading,
  motion = "fade",
  className,
}: KpiStripProps) {
  const hasPrimary = items.some((i) => i.primary);
  const rest = items.length - (hasPrimary ? 1 : 0);
  const total = Math.min(7, items.length + (hasPrimary ? 1 : 0));
  const sm = hasPrimary ? Math.max(1, Math.min(4, rest)) : 2;
  const hasHeader = Boolean(label || comparison);

  // Udda antal: sista cellen fyller raden i 2-kolumnsläget i stället för att lämna en tom halva.
  const last = items.length - 1;
  const fillLast = items.length % 2 === 1 && items.length > 1 && !items[last]?.primary;
  const baseStart = rowStarts(
    items.map((_, i) => (fillLast && i === last ? 2 : 1)),
    2,
  );
  const smStart = rowStarts(
    items.map((it, i) => (it.primary ? sm : !hasPrimary && fillLast && i === last ? 2 : 1)),
    sm,
  );
  const lgStart = rowStarts(
    items.map((i) => (i.primary ? 2 : 1)),
    total,
  );

  return (
    <section
      className={cn("min-w-0", !hasHeader && firstInPanel, lastInPanel, nestedReset, className)}
      aria-label={label ?? "Nyckeltal"}
    >
      {hasHeader ? (
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-3">
          {label ? <h3 className="label text-muted">{label}</h3> : <span />}
          {comparison ? <p className="meta tnum text-subtle">{comparison}</p> : null}
        </header>
      ) : null}
      <div className={cn("border-y border-line", !hasHeader && lineFirstInPanel, lineLastInPanel)}>
        <dl
          className={cn("grid grid-cols-2 overflow-hidden", smCols[sm], lgCols[total])}
          aria-busy={loading || undefined}
        >
          {items.map((item, i) => (
            <KpiCell
              key={item.id}
              item={item}
              loading={loading}
              motion={motion}
              span={cn(
                item.primary && smSpan[sm],
                item.primary && "lg:col-span-2",
                fillLast && i === last && (hasPrimary ? "col-span-2 sm:col-span-1" : "col-span-2"),
                fillLast && i === last && "lg:col-span-1",
                baseStart[i] ? "pl-0" : "pl-4",
                smStart[i] ? "sm:pl-0" : "sm:pl-4",
                lgStart[i] ? "lg:pl-0" : "lg:pl-5",
              )}
            />
          ))}
        </dl>
      </div>
    </section>
  );
}

function KpiCell({
  item,
  loading,
  motion,
  span,
}: {
  item: KpiItem;
  loading?: boolean;
  motion: KpiMotion;
  span?: string;
}) {
  const shown = useKpiValue(item.value, motion);
  const text = item.format(shown);
  const ref = useValueFade<HTMLElement>(item.format(item.value), motion === "fade");
  const { primary } = item;

  return (
    <div
      className={cn(
        "-mt-px -ml-px flex min-w-0 flex-col border-t border-l border-line py-4 pr-4 lg:pr-5",
        span,
      )}
    >
      <dt className="label truncate text-muted">{item.label}</dt>
      {loading ? (
        <dd className="mt-3 flex flex-col gap-2" aria-label="Laddar">
          <Skeleton className={cn("h-7", primary ? "w-40 sm:h-11" : "w-20 sm:h-8")} />
          <Skeleton className="h-3 w-16" />
        </dd>
      ) : (
        <>
          <dd
            ref={ref}
            className={cn(
              "tnum mt-3 truncate text-xl font-medium",
              primary ? "sm:text-3xl" : "sm:text-2xl",
            )}
          >
            {text}
          </dd>
          {item.delta ? (
            <dd className="mt-1">
              <KpiDelta spec={item.delta} />
            </dd>
          ) : null}
          {item.alert ? (
            <dd className="mt-2">
              <KpiAlert>{item.alertText ?? "Kräver åtgärd"}</KpiAlert>
            </dd>
          ) : null}
          {item.trend ? (
            <dd className="mt-auto hidden pt-4 sm:block">
              <KpiTrace
                data={item.trend}
                reference={item.reference}
                alert={item.alert}
                height={primary ? 40 : 32}
              />
            </dd>
          ) : null}
        </>
      )}
    </div>
  );
}
