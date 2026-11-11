"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { useFormat, useT } from "@/i18n/client";
import { cn } from "@/lib/cn";

import { updateMysteryCost } from "../actions";
import { krAuto } from "../_lib/kr";

/**
 * Notisen "Mystery pack premium kostar nu 213 kr, inte 174 kr": mystery-packets inköpspris
 * stämmer inte med kalkylen (en del har bytt pris eller innehållet är ändrat).
 *
 * Två val för den som får ändra priser (ägare och admin, även i Enkel vy), aldrig tyst:
 * - "Uppdatera priset från idag": ett nytt inköpspris från i dag. Sålda pack behåller sitt.
 * - "Rätta priset": priset gäller även allt som redan är sålt (som på Inköpspriser). Det går
 *   inte att ångra, så knappen frågar först ("Ja, rätta priset" / "Avbryt").
 * Beloppet räknas på servern; `calculatedOre` skickas bara med för att neka en inaktuell sida.
 */
export function CostNotice({
  titleId,
  name,
  currentOre,
  calculatedOre,
  canUpdate,
  href,
  className,
}: {
  titleId: string;
  name: string;
  currentOre: number | null;
  calculatedOre: number;
  canUpdate: boolean;
  /** Länk till kalkylen (på Inköpspriser), utelämnad på mystery-sidan. */
  href?: string;
  className?: string;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<"today" | "correct" | null>(null);
  // "Rätta priset" skriver om sålda pack: ett tryck till innan det görs.
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const amount = krAuto(f, calculatedOre);

  const run = (mode: "today" | "correct") => {
    setBusy(mode);
    start(async () => {
      const res = await updateMysteryCost({ titleId, expectedOre: calculatedOre, mode }).catch(
        () => ({ ok: false as const, error: t.common.offlineRetry }),
      );
      setBusy(null);
      setConfirming(false);
      if (!res.ok) {
        toast({
          title: t.mystery.costNotSaved,
          description: t.serverError(res.error),
          tone: "critical",
        });
        return;
      }
      toast({
        title: mode === "correct" ? t.mystery.costFixed(amount) : t.mystery.costUpdated(amount),
        tone: "ok",
      });
      router.refresh();
    });
  };

  return (
    <div
      role="status"
      data-testid="mystery-kostnad-notis"
      className={cn(
        "flex flex-col gap-3 rounded-md border border-signal-line bg-signal-soft px-4 py-3",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <p className="flex items-start gap-2 text-base font-medium [overflow-wrap:anywhere] text-fg">
          <Icon name="alert" size={16} className="mt-1 shrink-0 text-signal-fg" />
          <span>
            {t.mystery.costNow(name, amount, currentOre !== null ? krAuto(f, currentOre) : null)}
          </span>
        </p>
        <p className="text-base text-muted">
          {currentOre === null ? t.mystery.costMissingWhy : t.mystery.costNowWhy}
          {canUpdate ? "" : ` ${t.mystery.costNowAsk}`}
        </p>
      </div>
      {canUpdate && confirming ? (
        <div className="flex flex-col gap-2" data-testid="mystery-kostnad-bekrafta">
          <p className="text-base text-fg">{t.mystery.fixConfirm(amount)}</p>
          <div className="flex flex-col gap-2 md:flex-row">
            <button
              type="button"
              disabled={pending}
              onClick={() => run("correct")}
              className="flex min-h-12 flex-1 items-center justify-center rounded-md border border-inverse bg-inverse px-4 text-base font-medium text-on-inverse active:bg-inverse-hover disabled:border-dashed disabled:border-line-strong disabled:bg-transparent disabled:text-disabled"
            >
              {busy === "correct" ? t.common.saving : t.mystery.fixYes}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className="flex min-h-12 flex-1 items-center justify-center rounded-md border border-line-strong bg-surface px-4 text-base text-fg active:bg-hover disabled:border-dashed disabled:text-disabled"
            >
              {t.common.cancel}
            </button>
          </div>
        </div>
      ) : canUpdate ? (
        <div className="flex flex-col gap-2 md:flex-row">
          <button
            type="button"
            disabled={pending}
            onClick={() => run("today")}
            className="flex min-h-14 flex-1 flex-col items-start justify-center gap-0.5 rounded-md border border-inverse bg-inverse px-4 py-2 text-left text-on-inverse active:bg-inverse-hover disabled:border-dashed disabled:border-line-strong disabled:bg-transparent disabled:text-disabled"
          >
            <span className="text-base font-medium">
              {busy === "today" ? t.common.saving : t.mystery.updateFromToday}
            </span>
            <span className="text-sm opacity-80">{t.mystery.updateFromTodaySub}</span>
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(true)}
            className="flex min-h-14 flex-1 flex-col items-start justify-center gap-0.5 rounded-md border border-line-strong bg-surface px-4 py-2 text-left text-fg active:bg-hover disabled:border-dashed disabled:text-disabled"
          >
            <span className="text-base font-medium">{t.mystery.fixPrice}</span>
            <span className="text-sm text-muted">{t.mystery.fixPriceSub}</span>
          </button>
        </div>
      ) : null}
      {href ? (
        <Link
          href={href}
          className="inline-flex min-h-11 w-fit items-center text-base text-fg underline underline-offset-4"
        >
          {t.mystery.openCalc}
        </Link>
      ) : null}
    </div>
  );
}
