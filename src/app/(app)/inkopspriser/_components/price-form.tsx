"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { isIsoDate } from "@/domain";
import { EN_DASH, NBSP, formatInt, formatKronor, formatSignedKronor } from "@/lib/format";

import { addPurchasePrice } from "../actions";
import {
  PRICE_MESSAGES,
  formatDayShort,
  kr,
  parsePriceInput,
  previewPrice,
  sentence,
  type PricePreview,
} from "../_lib/model";

export interface PriceFormProps {
  titleId: string;
  titleName: string;
  prices: ReadonlyArray<{ unitCostOre: number; validFrom: string }>;
  orderDays: ReadonlyArray<{ date: string; orders: number }>;
  closedMonths: readonly string[];
  today: string;
}

function impactText(p: PricePreview, today: string): string {
  const until = p.validTo === null ? "tills vidare" : `t.o.m. ${formatDayShort(p.validTo, today)}`;
  if (p.affectedOrders === 0)
    return `${sentence(`Gäller ${until}`)} Inga befintliga order får nytt inköp.`;
  const span =
    p.firstDate && p.lastDate && p.firstDate !== p.lastDate
      ? `${formatDayShort(p.firstDate, today)}${NBSP}${EN_DASH}${NBSP}${formatDayShort(p.lastDate, today)}`
      : p.firstDate
        ? formatDayShort(p.firstDate, today)
        : "";
  const gaining =
    p.ordersGainingPrice > 0
      ? ` ${formatInt(p.ordersGainingPrice)} av dem saknade pris och räknas nu in i vinsten.`
      : "";
  return `${sentence(`Gäller ${until}`)} ${formatInt(p.affectedOrders)} order (${span}) får nytt inköp, totalt ${formatSignedKronor(kr(p.costDeltaOre))}.${gaining}`;
}

/** Formuläret för ett nytt inköpspris med förhandsvisning av vad det påverkar. */
export function PriceForm({
  titleId,
  titleName,
  prices,
  orderDays,
  closedMonths,
  today,
}: PriceFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [validFrom, setValidFrom] = useState(today);
  const [note, setNote] = useState("");
  const [amountError, setAmountError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const parsed = amount.trim() === "" ? null : parsePriceInput(amount);
  const dateOk = isIsoDate(validFrom);
  const ore = parsed && parsed.ok ? parsed.ore : 0;

  const preview = useMemo(() => {
    if (!dateOk) return null;
    return previewPrice({
      titleId,
      prices,
      orderDays,
      unitCostOre: ore,
      validFrom,
      closedMonths,
    });
  }, [titleId, prices, orderDays, ore, validFrom, closedMonths, dateOk]);

  const closedError =
    preview && preview.closedMonths.length > 0
      ? PRICE_MESSAGES.closedMonth(preview.closedMonths)
      : undefined;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const p = parsePriceInput(amount);
    if (!p.ok) {
      setAmountError(p.message);
      return;
    }
    setAmountError(undefined);
    if (!dateOk || closedError) return;
    setError(undefined);
    startTransition(async () => {
      const result = await addPurchasePrice({
        titleId,
        unitCostOre: p.ore,
        validFrom,
        note: note.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        title: result.data?.mode === "replaced" ? "Inköpspriset ändrat" : "Inköpspriset sparat",
        description: `${titleName}: ${formatKronor(kr(p.ore))} från ${formatDayShort(validFrom, today)}. Hem, Att göra och Lönsamhet räknas om.`,
        tone: "ok",
      });
      setAmount("");
      setNote("");
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-5"
      aria-label={`Nytt inköpspris för ${titleName}`}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Inköpspris per pack"
          name="unitCost"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0,00"
          suffix="kr"
          className="tnum text-right"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setAmountError(undefined);
            setError(undefined);
          }}
          onBlur={() => {
            if (amount.trim() !== "") {
              const p = parsePriceInput(amount);
              setAmountError(p.ok ? undefined : p.message);
            }
          }}
          error={amountError}
          required
        />
        <Input
          label="Giltig från"
          name="validFrom"
          type="date"
          value={validFrom}
          onChange={(e) => {
            setValidFrom(e.target.value);
            setError(undefined);
          }}
          error={!dateOk ? "Ange ett datum." : closedError}
          required
        />
      </div>
      <Input
        label="Anteckning"
        name="note"
        maxLength={200}
        autoComplete="off"
        placeholder="Till exempel ny leverantör eller leverans"
        hint="Valfri. Visas i prishistoriken."
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {preview && !closedError ? (
        <div aria-live="polite" className="flex flex-col gap-1 border-t border-line pt-4 text-sm">
          {preview.replaces ? (
            <p className="text-fg">
              Ersätter {formatKronor(kr(preview.replaces.unitCostOre))} från{" "}
              {formatDayShort(preview.replaces.validFrom, today)}.
            </p>
          ) : null}
          <p className="text-muted">
            {parsed && parsed.ok
              ? impactText(preview, today)
              : sentence(
                  `Gäller ${preview.validTo === null ? "tills vidare" : `t.o.m. ${formatDayShort(preview.validTo, today)}`}`,
                )}
          </p>
        </div>
      ) : null}

      <FormError message={error} />
      <div className="flex justify-end border-t border-line pt-4">
        <Button type="submit" variant="primary" loading={pending}>
          Spara pris
        </Button>
      </div>
    </form>
  );
}
