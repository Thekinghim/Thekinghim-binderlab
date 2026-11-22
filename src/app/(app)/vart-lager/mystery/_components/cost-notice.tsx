"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/toast";
import { useFormat, useT } from "@/i18n/client";
import { cn } from "@/lib/cn";

import { updateMysteryCost } from "../actions";
import { krAuto } from "../_lib/kr";

import "./mystery.css";

/**
 * Notisen "Mystery pack premium kostar nu 213 kr, inte 174 kr": mystery-packets inköpspris
 * stämmer inte med kalkylen (en del har bytt pris eller innehållet är ändrat).
 *
 * Två val för den som får ändra priser (ägare och admin, även i Enkel vy), aldrig tyst:
 * - "Uppdatera priset från i dag": ett nytt inköpspris från i dag. Sålda pack behåller sitt.
 * - "Rätta priset": priset gäller även allt som redan är sålt (som på Inköpspriser). Det går
 *   inte att ångra, så knappen frågar först ("Ja, rätta priset" / "Avbryt").
 * Saknar mystery-packet inköpspris helt finns inget gammalt pris att behålla: då finns en
 * enda knapp, "Lägg in priset 192 kr", och priset gäller även det som redan är sålt (annars
 * står de sålda packen kvar utan kostnad och punkten i Att göra försvinner inte).
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
        title:
          currentOre === null
            ? t.mystery.costAdded(amount)
            : mode === "correct"
              ? t.mystery.costFixed(amount)
              : t.mystery.costUpdated(amount),
        tone: "ok",
      });
      router.refresh();
    });
  };

  return (
    <div
      role="status"
      data-testid="mystery-kostnad-notis"
      className={cn("v2-notice warning flex-col !flex-nowrap gap-3", className)}
    >
      <div className="flex items-start gap-2.5">
        <span className="dot" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-[650] [overflow-wrap:anywhere]">
            {t.mystery.costNow(name, amount, currentOre !== null ? krAuto(f, currentOre) : null)}
          </p>
          <p>
            {currentOre === null ? t.mystery.costMissingWhy : t.mystery.costNowWhy}
            {canUpdate ? "" : ` ${t.mystery.costNowAsk}`}
          </p>
        </div>
      </div>
      {canUpdate && confirming ? (
        <div className="flex flex-col gap-2" data-testid="mystery-kostnad-bekrafta">
          <p className="text-v2-ink">{t.mystery.fixConfirm(amount)}</p>
          <div className="flex flex-col gap-2 md:flex-row">
            <button
              type="button"
              disabled={pending}
              onClick={() => run("correct")}
              className="v2-btn act lg md:flex-1"
            >
              {busy === "correct" ? t.common.saving : t.mystery.fixYes}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className="v2-btn lg md:flex-1"
            >
              {t.common.cancel}
            </button>
          </div>
        </div>
      ) : canUpdate && currentOre === null ? (
        <div className="mys-choice">
          <button
            type="button"
            disabled={pending}
            onClick={() => run("correct")}
            data-testid="mystery-kostnad-lagg-in"
            className="v2-btn act"
          >
            <span>{busy === "correct" ? t.common.saving : t.mystery.addPrice(amount)}</span>
            <small>{t.mystery.addPriceSub}</small>
          </button>
        </div>
      ) : canUpdate ? (
        <div className="mys-choice">
          <button
            type="button"
            disabled={pending}
            onClick={() => run("today")}
            className="v2-btn act"
          >
            <span>{busy === "today" ? t.common.saving : t.mystery.updateFromToday}</span>
            <small>{t.mystery.updateFromTodaySub}</small>
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(true)}
            className="v2-btn"
          >
            <span>{t.mystery.fixPrice}</span>
            <small>{t.mystery.fixPriceSub}</small>
          </button>
        </div>
      ) : null}
      {href ? (
        <Link
          href={href}
          className="inline-flex min-h-11 w-fit items-center font-[550] text-v2-ink underline underline-offset-[3px] md:min-h-8"
        >
          {t.mystery.openCalc}
        </Link>
      ) : null}
    </div>
  );
}
