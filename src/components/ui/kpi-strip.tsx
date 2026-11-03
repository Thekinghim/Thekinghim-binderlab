"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { CountUp } from "./count-up";
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
  /** Grunden för talet när den inte är självklar, t.ex. "på order med inköpspris". */
  note?: string;
};

type KpiStripProps = {
  items: ReadonlyArray<KpiItem>;
  /** Remsans etikett, t.ex. "Nyckeltal · 30 dagar" */
  label?: string;
  /**
   * Rubriknivå för etiketten. Standard h3 (remsan under en sektionsrubrik); h2 när
   * remsan står direkt under sidans h1, så att rubrikordningen inte hoppar över en nivå.
   */
  headingLevel?: 2 | 3;
  /** Skrivs en gång, t.ex. "Jämfört med 3 sep. – 2 okt." */
  comparison?: string;
  loading?: boolean;
  motion?: KpiMotion;
  className?: string;
  /** Namn för skärmläsare när remsan saknar synligt huvud (standard label, annars "Nyckeltal"). */
  ariaLabel?: string;
};

// Statiska klasser så att Tailwind hittar dem.
// Brytpunkterna gäller remsans egen bredd (container queries), inte fönstrets: bredvid
// sidomenyn är innehållet 250 px smalare, och ett belopp får aldrig klippas (design.md 5.1).
// @xl = 36 rem (576 px): huvudpersonen på egen rad. @4xl = 56 rem (896 px): en rad.
const lgCols: Record<number, string> = {
  2: "@4xl:grid-cols-2",
  3: "@4xl:grid-cols-3",
  4: "@4xl:grid-cols-4",
  5: "@4xl:grid-cols-5",
  6: "@4xl:grid-cols-6",
  7: "@4xl:grid-cols-7",
};
const smCols: Record<number, string> = {
  1: "@xl:grid-cols-1",
  2: "@xl:grid-cols-2",
  3: "@xl:grid-cols-3",
  4: "@xl:grid-cols-4",
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
  1: "@xl:col-span-1",
  2: "@xl:col-span-2",
  3: "@xl:col-span-3",
  4: "@xl:col-span-4",
};

export type KpiStripCellLayout = {
  /** Kolumner i 2-kolumnsläget (under @xl). */
  baseSpan: 1 | 2;
  /** Kolumner i mellanläget (@xl). */
  smSpan: number;
  /** Cellen står först i sin rad (ingen vänsterluft) i respektive läge. */
  baseStart: boolean;
  smStart: boolean;
  lgStart: boolean;
};

/**
 * Remsans rutnät i de tre lägena, ren funktion (testas i kpi-strip.test.ts).
 * - Under @xl: 2 kolumner; vid udda antal fyller sista cellen raden.
 * - @xl: huvudpersonen först på egen rad (CSS-order), övriga under i upp till 4 kolumner;
 *   en ofull sista rad fylls av sista cellen, så att ingen tom ruta blir kvar.
 * - @4xl: en rad, huvudpersonen spänner två kolumner.
 */
export function kpiStripLayout(items: ReadonlyArray<{ primary?: boolean }>): {
  sm: number;
  total: number;
  cells: KpiStripCellLayout[];
} {
  const hasPrimary = items.some((i) => i.primary);
  const rest = items.length - (hasPrimary ? 1 : 0);
  const total = Math.min(7, items.length + (hasPrimary ? 1 : 0));
  const sm = hasPrimary ? Math.max(1, Math.min(4, rest)) : 2;

  const last = items.length - 1;
  const fillLast = items.length % 2 === 1 && items.length > 1 && !items[last]?.primary;
  const baseSpan = (i: number): 1 | 2 => (fillLast && i === last ? 2 : 1);
  const baseStart = rowStarts(
    items.map((_, i) => baseSpan(i)),
    2,
  );

  const indices = items.map((_, i) => i);
  const others = indices.filter((i) => !items[i]?.primary);
  const lastOther = others[others.length - 1];
  const lastRow = others.length % sm || sm;
  const smSpanOf = (i: number) =>
    items[i]?.primary ? sm : i === lastOther && lastRow < sm ? sm - lastRow + 1 : 1;
  const smOrder = [...indices.filter((i) => items[i]?.primary), ...others];
  const smStartOrdered = rowStarts(smOrder.map(smSpanOf), sm);
  const lgStart = rowStarts(
    items.map((i) => (i.primary ? 2 : 1)),
    total,
  );

  return {
    sm,
    total,
    cells: indices.map((i) => ({
      baseSpan: baseSpan(i),
      smSpan: smSpanOf(i),
      baseStart: baseStart[i] ?? false,
      smStart: smStartOrdered[smOrder.indexOf(i)] ?? false,
      lgStart: lgStart[i] ?? false,
    })),
  };
}

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
  headingLevel = 3,
  comparison,
  loading,
  motion = "count",
  className,
  ariaLabel,
}: KpiStripProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const hasHeader = Boolean(label || comparison);
  const layout = kpiStripLayout(items);
  const { sm, total } = layout;
  // Cellerna utom huvudpersonen delar storlekssteg: behöver ett belopp krympa för att rymmas
  // krymper hela raden lika mycket, så att talen står i samma storlek och baslinje.
  const [steps, setSteps] = useState<Readonly<Record<string, number>>>({});
  const reportStep = useCallback((id: string, step: number) => {
    setSteps((s) => (s[id] === step ? s : { ...s, [id]: step }));
  }, []);
  const sharedStep = sharedFitStep(items, steps);

  return (
    <section
      className={cn(
        "@container min-w-0",
        !hasHeader && firstInPanel,
        lastInPanel,
        nestedReset,
        className,
      )}
      aria-label={ariaLabel ?? label ?? "Nyckeltal"}
    >
      {hasHeader ? (
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-3">
          {label ? <Heading className="label text-muted">{label}</Heading> : <span />}
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
              index={i}
              loading={loading}
              motion={motion}
              minStep={item.primary ? 0 : sharedStep}
              onStep={reportStep}
              span={cn(
                layout.cells[i]?.baseSpan === 2 && "col-span-2",
                smSpan[layout.cells[i]?.smSpan ?? 1],
                item.primary
                  ? "@xl:order-first @4xl:order-none @4xl:col-span-2"
                  : "@4xl:col-span-1",
                layout.cells[i]?.baseStart ? "pl-0" : "pl-4",
                layout.cells[i]?.smStart ? "@xl:pl-0" : "@xl:pl-4",
                layout.cells[i]?.lgStart ? "@4xl:pl-0" : "@4xl:pl-5",
              )}
            />
          ))}
        </dl>
      </div>
    </section>
  );
}

/**
 * Storlekssteg för värdet, störst först. Steg 0 är remsans vanliga storlek (från @xl:
 * 44 px för huvudpersonen, 32 px för övriga); ryms beloppet inte i cellen tas nästa steg.
 */
const PRIMARY_SIZES = [
  "text-xl @xl:text-3xl",
  "text-xl @xl:text-2xl",
  "text-xl",
  "text-lg",
  "text-md",
];
const VALUE_SIZES = ["text-xl @xl:text-2xl", "text-xl", "text-lg", "text-md"];

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Det storlekssteg cellerna utom huvudpersonen delar: det största steg någon av dem behöver
 * (ren funktion, testas i kpi-strip.test.ts). Celler som inte rapporterat räknas som steg 0.
 */
export function sharedFitStep(
  items: ReadonlyArray<{ id: string; primary?: boolean }>,
  steps: Readonly<Record<string, number>>,
): number {
  return items.reduce((max, i) => (i.primary ? max : Math.max(max, steps[i.id] ?? 0)), 0);
}

/**
 * Minskar värdets storlek ett steg i taget tills texten ryms (scrollWidth ≤ clientWidth),
 * i stället för att klippa den. Börjar om från steg 0 när texten eller cellens bredd
 * ändras. Före hydrering visas steg 0 (med ellips om det inte ryms).
 */
function useFitStep(
  ref: React.RefObject<HTMLElement | null>,
  text: string,
  max: number,
  minStep = 0,
): { own: number; shown: number } {
  const [state, setState] = useState({ step: 0, text, width: 0 });
  // Ny text: börja om från största storleken (justeras under rendering, inte i en effekt).
  let step = state.step;
  if (state.text !== text) {
    step = 0;
    setState({ step: 0, text, width: state.width });
  }
  // Visat steg: cellens eget eller radens gemensamma, det som är mindre (högre steg).
  const shown = Math.min(max, Math.max(step, minStep));
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Mät den nya storleken direkt: med reducerad rörelse har alla egenskaper en övergång
    // på 1 ms (globals.css), och då står den gamla teckenstorleken kvar i mätningen.
    el.style.transition = "none";
    const overflows = el.scrollWidth > el.clientWidth + 1;
    el.style.transition = "";
    if (shown < max && overflows) {
      // Bara ett steg per mätning, även när effekten körs två gånger (StrictMode).
      setState((s) => (s.step === step ? { ...s, step: shown + 1 } : s));
    }
  });
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setState((s) => (s.width === w ? s : { ...s, step: 0, width: w }));
    });
    ro.observe(el);
    // Typsnittet kan bytas efter första mätningen (font-display: swap): mät om när det är laddat.
    let live = true;
    document.fonts?.ready.then(() => {
      if (live) setState((s) => ({ ...s, step: 0 }));
    });
    return () => {
      live = false;
      ro.disconnect();
    };
  }, [ref]);
  return { own: step, shown };
}

function KpiCell({
  item,
  index = 0,
  loading,
  motion,
  span,
  minStep = 0,
  onStep,
}: {
  item: KpiItem;
  /** Plats i remsan: cellerna glider upp i tur och ordning. */
  index?: number;
  loading?: boolean;
  motion: KpiMotion;
  span?: string;
  /** Radens gemensamma storlekssteg (för celler utom huvudpersonen). */
  minStep?: number;
  /** Rapporterar steget cellen själv behöver, så att raden kan dela det. */
  onStep?: (id: string, step: number) => void;
}) {
  // Heltal (öre, bp, antal) räknas vid första visningen och när värdet ändras.
  const countUp = motion === "count" && Number.isInteger(item.value);
  const shown = useKpiValue(item.value, countUp ? "none" : motion);
  const text = item.format(shown);
  const finalText = item.format(item.value);
  const ref = useValueFade<HTMLElement>(finalText, motion === "fade");
  const { primary } = item;
  const sizes = primary ? PRIMARY_SIZES : VALUE_SIZES;
  const fit = useFitStep(ref, finalText, sizes.length - 1, minStep);
  const step = fit.shown;
  const { id } = item;
  useEffect(() => {
    onStep?.(id, fit.own);
  }, [onStep, id, fit.own]);

  return (
    <div
      className={cn(
        "group/kpi rise -mt-px -ml-px flex min-w-0 flex-col border-t border-l border-line py-4 pr-4 transition-colors duration-300 hover:bg-hover/40 @4xl:pr-5",
        span,
      )}
      style={{ "--i": Math.min(index, 6) } as React.CSSProperties}
    >
      <dt className="label truncate text-muted">{item.label}</dt>
      {loading ? (
        <dd className="mt-3 flex flex-col gap-2" aria-label="Laddar">
          <Skeleton className={cn("h-7", primary ? "w-40 @xl:h-11" : "w-20 @xl:h-8")} />
          <Skeleton className="h-3 w-16" />
        </dd>
      ) : (
        <>
          <dd
            ref={ref}
            className={cn(
              "tnum mt-3 truncate font-medium transition-transform duration-300 group-hover/kpi:-translate-y-0.5",
              sizes[step],
            )}
          >
            {countUp ? <CountUp id={item.id} value={item.value} format={item.format} /> : text}
          </dd>
          {item.delta ? (
            <dd className="mt-1">
              <KpiDelta spec={item.delta} />
            </dd>
          ) : null}
          {item.note ? <dd className="meta mt-1 text-subtle">{item.note}</dd> : null}
          {item.alert ? (
            <dd className="mt-2">
              <KpiAlert>{item.alertText ?? "Kräver åtgärd"}</KpiAlert>
            </dd>
          ) : null}
          {item.trend ? (
            <dd className="mt-auto hidden pt-4 @xl:block">
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
