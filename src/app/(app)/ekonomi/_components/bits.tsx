"use client";

/**
 * Små klientdelar som Ekonomi och Avtal delar: nyckeltalsremsa med öre/antal, flerradigt
 * textfält i samma form som Input, och felrad i formulär.
 */

import { forwardRef, useId, type TextareaHTMLAttributes } from "react";

import { Icon } from "@/components/ui/icon";
import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import { cn } from "@/lib/cn";
import { formatInt, formatPercent, formatSek, formatSignedKronor } from "@/lib/format";

export type EconomyKpi = {
  id: string;
  label: string;
  value: number | null;
  unit: "ore" | "signed-ore" | "count" | "bp";
  primary?: boolean;
  alert?: boolean;
  alertText?: string;
};

const FORMAT: Record<EconomyKpi["unit"], (v: number) => string> = {
  ore: (v) => formatSek(v / 100),
  "signed-ore": (v) => formatSignedKronor(v / 100, { decimals: 2 }),
  count: (v) => formatInt(v),
  bp: (v) => formatPercent(v / 10_000),
};

/** Nyckeltalsremsa där värdena är öre, antal eller bp. */
export function EconomyKpis({ items, label }: { items: readonly EconomyKpi[]; label: string }) {
  const kpis: KpiItem[] = items.map((k) => ({
    id: k.id,
    label: k.label,
    value: k.value ?? Number.NaN,
    format: FORMAT[k.unit],
    primary: k.primary,
    alert: k.alert,
    alertText: k.alertText,
  }));
  return <KpiStrip items={kpis} label={label} />;
}

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: string;
  error?: string;
};

/** Flerradigt fält med samma etikett, kant och felvisning som Input. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, className, id: idProp, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="label text-muted">
        {label}
      </label>
      <textarea
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-msg` : undefined}
        className={cn(
          "min-h-24 w-full min-w-0 rounded-sm border bg-bg px-3 py-2 text-base text-fg transition-[border-color] duration-fast ease-instrument placeholder:text-subtle hover:border-muted",
          error ? "border-signal" : "border-line-control",
          className,
        )}
        {...rest}
      />
      {error ? (
        <p id={`${id}-msg`} className="flex items-center gap-1.5 text-xs text-signal-fg">
          <Icon name="alert" size={12} />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className="text-xs text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

/** Felrad i ett formulär: ikon och text (inte bara färg), läses upp direkt. */
export function FormError({ message }: { message?: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-signal-fg empty:hidden">
      {message ? (
        <>
          <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
          <span>{message}</span>
        </>
      ) : null}
    </p>
  );
}

/** Knappraden i en dialog: avbryt till vänster, åtgärd till höger (överst på mobil). */
export function DialogButtons({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
      {children}
    </div>
  );
}
