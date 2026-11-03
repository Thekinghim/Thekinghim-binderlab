"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { StatusGlyph } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { isIsoDate } from "@/domain";
import { formatInt, formatKronor, formatPeriodShort, formatSignedKronor } from "@/lib/format";
import { useHydrated } from "@/lib/use-hydrated";

import { addPurchasePrice } from "../actions";
import {
  PRICE_MESSAGES,
  formatDayShort,
  kr,
  parsePriceInput,
  dayDate,
  previewPrice,
  sentence,
  suggestedValidFrom,
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

/** "20–26 okt." / "27 okt." (året bara om det inte är i år). */
function span(first: string, last: string, today: string): string {
  return formatPeriodShort({ start: dayDate(first), end: dayDate(last) }, dayDate(today));
}

function impactText(p: PricePreview, today: string): string {
  const until = p.validTo === null ? "tills vidare" : `t.o.m. ${formatDayShort(p.validTo, today)}`;
  if (p.affectedOrders === 0)
    return `${sentence(`Gäller ${until}`)} Inga befintliga order får nytt inköp.`;
  const days = p.firstDate ? span(p.firstDate, p.lastDate ?? p.firstDate, today) : "";
  const gaining =
    p.ordersGainingPrice > 0
      ? ` ${formatInt(p.ordersGainingPrice)} av dem saknade pris och räknas nu in i vinsten.`
      : "";
  return `${sentence(`Gäller ${until}`)} ${formatInt(p.affectedOrders)} order (${days}) får nytt inköp, totalt ${formatSignedKronor(kr(p.costDeltaOre))}.${gaining}`;
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
  const suggested = useMemo(
    () => suggestedValidFrom(prices, orderDays, closedMonths, today),
    [prices, orderDays, closedMonths, today],
  );
  const [validFrom, setValidFrom] = useState(suggested);
  const [note, setNote] = useState("");
  const [amountError, setAmountError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  // Före hydreringen skulle knappen skicka formuläret som en vanlig sidladdning: priset
  // försvann utan fel. Knappen är därför avstängd tills sidans skript har laddats.
  const ready = useHydrated();

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
        description: sentence(
          `${titleName}: ${formatKronor(kr(p.ore))} från ${formatDayShort(validFrom, today)}`,
        ),
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
              {sentence(
                `Ersätter ${formatKronor(kr(preview.replaces.unitCostOre))} från ${formatDayShort(preview.replaces.validFrom, today)}`,
              )}
            </p>
          ) : null}
          <p className="text-muted">
            {parsed && parsed.ok
              ? impactText(preview, today)
              : sentence(
                  `Gäller ${preview.validTo === null ? "tills vidare" : `t.o.m. ${formatDayShort(preview.validTo, today)}`}`,
                )}
          </p>
          {preview.stillUnpriced ? (
            <div className="mt-2 flex flex-col items-start gap-2 rounded-sm border border-line-control px-3 py-2.5">
              <p className="flex items-baseline gap-2 text-fg">
                <span className="translate-y-px">
                  <StatusGlyph status="warning" />
                </span>
                <span>
                  {formatInt(preview.stillUnpriced.orders)} order (
                  {span(preview.stillUnpriced.firstDate, preview.stillUnpriced.lastDate, today)})
                  saknar fortfarande inköpspris och räknas inte in i vinsten.
                </span>
              </p>
              {suggested !== validFrom && suggested <= preview.stillUnpriced.lastDate ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setValidFrom(suggested);
                    setError(undefined);
                  }}
                >
                  Sätt giltig från {formatDayShort(suggested, today)}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <FormError message={error} />
      <div className="flex justify-end border-t border-line pt-4">
        <Button type="submit" variant="primary" loading={pending} disabled={!ready}>
          Spara pris
        </Button>
      </div>
    </form>
  );
}
