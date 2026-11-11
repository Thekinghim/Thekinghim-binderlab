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
  parseVatLimitInput,
  vatLimitToInput,
} from "../_lib/model";

/** Kortavgift, momssats, räkenskapsårets start och momsgränsen vi varnar vid. Ägare och admin. */
export function SettingsForm({
  cardFeeBp,
  vatRateBp,
  fiscalYearStartMonth,
  vatLimitOre,
}: {
  cardFeeBp: number;
  vatRateBp: number;
  fiscalYearStartMonth: number;
  vatLimitOre: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [fee, setFee] = useState(bpToInput(cardFeeBp));
  const [vat, setVat] = useState(bpToInput(vatRateBp));
  const [month, setMonth] = useState(String(fiscalYearStartMonth));
  const [limit, setLimit] = useState(vatLimitToInput(vatLimitOre));
  const [limitError, setLimitError] = useState<string>();
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
    const l = parseVatLimitInput(limit);
    setLimitError(l.ok ? undefined : l.message);
    if (!f.ok || !v.ok || !l.ok) return;
    setError(undefined);
    startTransition(async () => {
      const result = await updateSettings({
        cardFeeBp: f.bp,
        vatRateBp: v.bp,
        fiscalYearStartMonth: Number(month),
        vatLimitOre: l.ore,
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
          hint="Av betalt belopp inkl. moms."
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
          hint={vatRateBp === 0 ? "0 % när bolaget inte är momsregistrerat." : undefined}
        />
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        <Select
          label="Räkenskapsåret börjar"
          name="fiscalYearStartMonth"
          options={MONTH_OPTIONS}
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setError(undefined);
          }}
        />
        <Input
          label="Momsgräns"
          name="vatLimit"
          inputMode="numeric"
          autoComplete="off"
          suffix="kr"
          className="tnum text-right"
          value={limit}
          onChange={(e) => {
            setLimit(e.target.value);
            setLimitError(undefined);
            setError(undefined);
          }}
          error={limitError}
          hint="Appen säger till när årets försäljning närmar sig."
        />
      </div>
      <p className="border-t border-line pt-4 text-sm text-muted">
        Gäller bakåt. Stängda månader ändras inte.
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
