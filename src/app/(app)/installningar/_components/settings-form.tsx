"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

import { updateSettings } from "../_actions/settings";
import {
  MAX_FEE_BP,
  MAX_VAT_BP,
  MONTH_OPTIONS,
  bpToInput,
  formatBp,
  parsePercentInput,
} from "../_lib/model";

/** Kortavgift, momssats och räkenskapsårets start. Ägare och admin. */
export function SettingsForm({
  cardFeeBp,
  vatRateBp,
  fiscalYearStartMonth,
}: {
  cardFeeBp: number;
  vatRateBp: number;
  fiscalYearStartMonth: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [fee, setFee] = useState(bpToInput(cardFeeBp));
  const [vat, setVat] = useState(bpToInput(vatRateBp));
  const [month, setMonth] = useState(String(fiscalYearStartMonth));
  const [feeError, setFeeError] = useState<string>();
  const [vatError, setVatError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = parsePercentInput(fee, MAX_FEE_BP);
    const v = parsePercentInput(vat, MAX_VAT_BP);
    setFeeError(f.ok ? undefined : f.message);
    setVatError(v.ok ? undefined : v.message);
    if (!f.ok || !v.ok) return;
    setError(undefined);
    startTransition(async () => {
      const result = await updateSettings({
        cardFeeBp: f.bp,
        vatRateBp: v.bp,
        fiscalYearStartMonth: Number(month),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        title: result.data?.changed ? "Inställningarna sparade" : "Inget att spara",
        description: result.data?.changed
          ? `Kortavgift ${formatBp(f.bp)}, moms ${formatBp(v.bp)} i alla öppna månader.`
          : "Värdena var redan inlagda.",
        tone: result.data?.changed ? "ok" : "neutral",
      });
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-5"
      aria-label="Avgifter och moms"
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        <Input
          label="Kortavgift"
          name="cardFee"
          inputMode="decimal"
          autoComplete="off"
          suffix="%"
          className="tnum text-right"
          value={fee}
          onChange={(e) => {
            setFee(e.target.value);
            setFeeError(undefined);
            setError(undefined);
          }}
          error={feeError}
          hint="Andel av det betalda beloppet, inklusive moms, som kortinlösaren tar per order."
        />
        <Input
          label="Momssats"
          name="vatRate"
          inputMode="decimal"
          autoComplete="off"
          suffix="%"
          className="tnum text-right"
          value={vat}
          onChange={(e) => {
            setVat(e.target.value);
            setVatError(undefined);
            setError(undefined);
          }}
          error={vatError}
          hint={
            vatRateBp === 0
              ? "0 gäller nu: bolaget är inte momsregistrerat, så hela det betalda beloppet är intäkt."
              : `${formatBp(vatRateBp)} gäller nu: momsen räknas ur det betalda beloppet och intäkten är resten.`
          }
        />
      </div>
      <Select
        label="Räkenskapsåret börjar"
        name="fiscalYearStartMonth"
        options={MONTH_OPTIONS}
        value={month}
        onChange={(e) => {
          setMonth(e.target.value);
          setError(undefined);
        }}
        wrapperClassName="sm:max-w-[calc(50%-8px)]"
      />
      <p className="border-t border-line pt-4 text-sm text-muted">
        Satserna gäller alla perioder, även bakåt i tiden. Stängda månader behåller sina sparade
        siffror.
      </p>
      <FormError message={error} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={pending}>
          Spara
        </Button>
      </div>
    </form>
  );
}
