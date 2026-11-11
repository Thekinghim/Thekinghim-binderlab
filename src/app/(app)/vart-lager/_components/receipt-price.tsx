"use client";

/**
 * Priset vid en leverans, delat av "+ Inköp" på Vårt lager och delägarens leveransformulär:
 * fältet är förifyllt med dagens inköpspris. Samma pris: inget mer. Annat pris: en rad
 * innan man sparar, "Nytt pris 118 kr (var 112 kr). Kvar per pack blir 31 kr.", och priset
 * sparas från i dag i samma steg (addReceipt). Ser priset konstigt ut frågar servern först
 * (gul rad och ett extra tryck).
 */

import { useEffect, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { useFormat, useLocale, useT } from "@/i18n/client";

import { previewPriceSplit } from "../../inkopspriser/actions";
import type { PriceDoubt } from "../../inkopspriser/_lib/price-check";
import {
  priceFieldText,
  receiptPriceOre,
  receiptPriceState,
  type ReceiptPriceState,
} from "../_lib/receipt-price";

export interface ReceiptPrice {
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly state: ReceiptPriceState;
  /** Priset att skicka med (undefined = tomt fält eller inget prisfält). */
  readonly ore: number | undefined;
  readonly doubt: PriceDoubt | null;
  readonly setDoubt: (doubt: PriceDoubt | null) => void;
  /** Fyll i dagens pris igen (när formuläret öppnas). */
  readonly reset: () => void;
}

/** Fältets läge. `enabled` false (egen produkt, ingen rätt att ändra pris): inget pris. */
export function useReceiptPrice(currentOre: number | null, enabled: boolean): ReceiptPrice {
  const locale = useLocale();
  const initial = currentOre === null ? "" : priceFieldText(currentOre, locale);
  const [text, setTextRaw] = useState(initial);
  const [doubt, setDoubt] = useState<PriceDoubt | null>(null);
  const state: ReceiptPriceState = enabled
    ? receiptPriceState(text, currentOre)
    : { kind: "empty" };
  return {
    text,
    setText: (v) => {
      setTextRaw(v);
      setDoubt(null);
    },
    state,
    ore: receiptPriceOre(state),
    doubt,
    setDoubt,
    reset: () => {
      setTextRaw(initial);
      setDoubt(null);
    },
  };
}

/** Kronor utan ",00" när det är jämna kronor: "118 kr" · "112,50 kr". */
function useKr(): (ore: number) => string {
  const f = useFormat();
  return (ore) => (ore % 100 === 0 ? f.sek(ore / 100) : f.kronor(ore / 100));
}

/**
 * Raden under fältet: felet, frågan från servern (konstigt pris) eller vad det nya priset
 * gör. Tom när priset är samma som i dag.
 */
export function ReceiptPriceNote({
  titleId,
  currentOre,
  price,
  className,
}: {
  titleId: string;
  currentOre: number | null;
  price: ReceiptPrice;
  className?: string;
}) {
  const r2 = useT().r2.t3;
  const kr = useKr();
  const { state, doubt } = price;
  const newOre = state.kind === "new" ? state.ore : null;
  // Kvar per pack med det nya priset: samma uträkning som Inköpspriser (före butikens andel).
  const [left, setLeft] = useState<{ ore: number; leftOre: number | null } | null>(null);
  useEffect(() => {
    if (newOre === null) return;
    let live = true;
    const timer = setTimeout(() => {
      previewPriceSplit({ titleId, unitCostOre: newOre, query: "" })
        .then((r) => {
          if (live)
            setLeft({ ore: newOre, leftOre: r.ok ? (r.data?.leftBeforeOre ?? null) : null });
        })
        .catch(() => {});
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [newOre, titleId]);

  if (state.kind === "invalid") {
    return (
      <p role="alert" className={`text-sm text-signal-fg ${className ?? ""}`}>
        {r2.receiptPriceInvalid}
      </p>
    );
  }
  if (doubt) {
    const now = kr(doubt.newOre);
    const ref = kr(doubt.refOre);
    return (
      <p
        role="alert"
        className={`flex items-start gap-2 rounded-md border border-signal-line bg-signal-soft px-3 py-2 text-left text-sm text-fg ${className ?? ""}`}
      >
        <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
        <span>
          {doubt.kind === "aboveSale"
            ? r2.priceAboveSale(now, ref)
            : doubt.kind === "higher"
              ? r2.priceMuchHigher(now, ref)
              : r2.priceMuchLower(now, ref)}
        </span>
      </p>
    );
  }
  if (newOre === null) return null;
  const leftOre = left && left.ore === newOre ? left.leftOre : null;
  return (
    <p aria-live="polite" className={`text-sm text-fg ${className ?? ""}`}>
      {currentOre === null
        ? r2.receiptFirstPrice(kr(newOre))
        : r2.receiptNewPrice(kr(newOre), kr(currentOre))}
      {leftOre !== null ? ` ${r2.receiptLeft(kr(leftOre))}` : ""}
    </p>
  );
}
