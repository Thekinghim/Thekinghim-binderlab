"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { updateSettings } from "../_actions/settings";
import {
  MAX_FEE_BP,
  MAX_VAT_BP,
  MONTH_OPTIONS,
  bpToInput,
  cardFeeConfirm,
  cardFeeDone,
  cardFeeHistoryLines,
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
  cardFeeDefaultFrom,
  cardFeeRates = [],
  today,
}: {
  /** Förvalt startdatum för en ändrad kortavgift: första dagen som inte är låst. null = allt. */
  cardFeeDefaultFrom: string | null;
  cardFeeRates?: readonly { validFrom: string; cardFeeBp: number }[];
  today: string;
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
  const [feeFrom, setFeeFrom] = useState(cardFeeDefaultFrom ?? "");
  // Frågan innan kortavgiften ändras (från vilken dag den gäller).
  const [ask, setAsk] = useState<{ bp: number; from: string | null } | null>(null);
  const parsedFee = parsePercentInput(fee, MAX_FEE_BP);
  const feeChanged = parsedFee.ok && parsedFee.bp !== cardFeeBp;
  const historyLines = cardFeeHistoryLines(
    cardFeeRates.map((r) => ({ validFrom: r.validFrom as never, cardFeeBp: r.cardFeeBp })),
  );

  const save = (confirmed: boolean) => {
    const f = parsePercentInput(fee, MAX_FEE_BP);
    const v = parsePercentInput(vat, MAX_VAT_BP);
    setFeeError(f.ok ? undefined : f.message);
    setVatError(v.ok ? undefined : v.message);
    const l = parseVatLimitInput(limit);
    setLimitError(l.ok ? undefined : l.message);
    if (!f.ok || !v.ok || !l.ok) return;
    setError(undefined);
    const from = feeFrom === "" ? null : feeFrom;
    // En ändrad kortavgift sparas först när ägaren sett från vilken dag den gäller.
    if (f.bp !== cardFeeBp && !confirmed) {
      setAsk({ bp: f.bp, from });
      return;
    }
    startTransition(async () => {
      const result = await updateSettings({
        cardFeeBp: f.bp,
        vatRateBp: v.bp,
        fiscalYearStartMonth: Number(month),
        vatLimitOre: l.ore,
        ...(f.bp !== cardFeeBp ? { cardFeeFrom: from } : {}),
      });
      setAsk(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        title: result.data?.changed ? "Inställningarna sparade" : "Inget att spara",
        description: result.data?.changed
          ? f.bp !== cardFeeBp
            ? cardFeeDone(f.bp, from)
            : `Kortavgift ${formatBp(f.bp)}, moms ${formatBp(v.bp)}.`
          : "Värdena var redan inlagda.",
        tone: result.data?.changed ? "ok" : "neutral",
      });
      router.refresh();
    });
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    save(false);
  };
  const confirmText = ask ? cardFeeConfirm(ask.bp, cardFeeBp, ask.from) : null;

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
      {feeChanged ? (
        <Input
          label="Kortavgiften gäller från"
          name="cardFeeFrom"
          type="date"
          max={today}
          value={feeFrom}
          onChange={(e) => {
            setFeeFrom(e.target.value);
            setError(undefined);
          }}
          hint="Försäljning före dagen räknas som förut. Tomt = all försäljning."
          wrapperClassName="sm:max-w-xs"
        />
      ) : null}
      {historyLines.length > 0 ? (
        <p className="text-v2-sm text-v2-mute" data-card-fee-history>
          Kortavgift: {historyLines.join(" · ")}
        </p>
      ) : null}
      <p className="border-t border-v2-line2 pt-4 text-v2-sm text-v2-mute">
        Kortavgiften gäller från ett datum. Momssatsen gäller bakåt. Stängda månader ändras inte.
      </p>
      <Modal
        open={ask !== null}
        onClose={() => (pending ? undefined : setAsk(null))}
        eyebrow="Kortavgift"
        title={confirmText?.title ?? ""}
        description={confirmText?.text}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAsk(null)} disabled={pending}>
              Avbryt
            </Button>
            <Button variant="primary" loading={pending} onClick={() => save(true)}>
              {confirmText?.button ?? "Ändra"}
            </Button>
          </>
        }
      />
      <FormError message={error} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={pending}>
          Spara
        </Button>
      </div>
    </form>
  );
}
