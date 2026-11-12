"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

import { addManualPayout, payoutExpectation } from "../actions";
import { payoutQuestionText } from "../_lib/headline";
import { amountField, signedSek } from "../_lib/view";
import { FormError } from "./bits";

/**
 * "Vad betalade Nayax?": ägaren skriver in beloppet som kom in och dagen, i stället för att
 * ladda upp en fil. "Samma belopp" fyller i det försäljningen ger. Perioden är nästa period
 * utan utbetalning; den går att ändra under "Ändra period" (då räknas det väntade beloppet
 * om på servern). Efter Spara visar avstämningen skillnaden.
 */
export function PayoutQuestion({
  period: initialPeriod,
  expectedOre: initialExpected,
  today,
  lead,
}: {
  period: { start: string; end: string };
  /** Väntat enligt försäljningen, efter avgifter och återbetalningar. */
  expectedOre: number;
  today: string;
  /** Visa frågan som text i rutan (när sidans rubrik säger något annat). */
  lead: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [period, setPeriod] = useState(initialPeriod);
  const [expectedOre, setExpectedOre] = useState<number | null>(initialExpected);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const [counting, startCount] = useTransition();

  const changePeriod = (next: { start: string; end: string }) => {
    setPeriod(next);
    setError(undefined);
    setExpectedOre(null);
    if (!next.start || !next.end || next.end < next.start || next.end >= today) return;
    startCount(async () => {
      const res = await payoutExpectation(next).catch(() => null);
      if (res?.ok && res.data.start === next.start && res.data.end === next.end) {
        setExpectedOre(res.data.payoutOre);
      }
    });
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!amount.trim()) {
      setError("Skriv beloppet som kom in.");
      return;
    }
    if (!period.start || !period.end) {
      setError("Välj första och sista dag.");
      return;
    }
    setError(undefined);
    startTransition(async () => {
      const res = await addManualPayout({ ...period, amount, paidOn }).catch(() => ({
        ok: false as const,
        error: "Ingen kontakt med servern. Försök igen.",
      }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast({
        title: "Utbetalningen är sparad",
        description: res.data.matches
          ? "Den stämmer med försäljningen."
          : `Skillnad ${signedSek(res.data.differenceOre)} mot försäljningen. Se avstämningen.`,
        tone: res.data.matches ? "ok" : "neutral",
      });
      setAmount("");
      router.refresh();
    });
  };

  const text = expectedOre === null ? null : payoutQuestionText(period, expectedOre, today);

  return (
    <form
      onSubmit={submit}
      noValidate
      data-payout-question
      className="flex flex-col gap-4 rounded-md border border-line bg-surface p-4 md:p-5"
    >
      {lead || period !== initialPeriod ? (
        <div className="flex flex-col gap-1">
          <p className="text-lg font-medium text-fg">Vad betalade Nayax?</p>
          <p className="text-base text-muted" aria-live="polite">
            {text ? text.title : counting ? "Räknar…" : "Välj en period som är slut."}
          </p>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          label="Belopp som kom in"
          inputMode="decimal"
          suffix="kr"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Input
          label="Dag pengarna kom"
          type="date"
          max={today}
          value={paidOn}
          onChange={(e) => setPaidOn(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" loading={pending} className="min-h-11 max-md:grow">
          Spara
        </Button>
        {expectedOre !== null && expectedOre > 0 ? (
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 max-md:grow"
            disabled={pending}
            onClick={() => {
              setAmount(amountField(expectedOre));
              setError(undefined);
            }}
          >
            Samma belopp
          </Button>
        ) : null}
      </div>
      <FormError message={error} />
      <details className="text-sm text-muted">
        <summary className="flex min-h-11 w-fit cursor-pointer items-center underline-offset-4 hover:text-fg hover:underline">
          Ändra period
        </summary>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Första dag"
            type="date"
            max={today}
            value={period.start}
            onChange={(e) => changePeriod({ ...period, start: e.target.value })}
          />
          <Input
            label="Sista dag"
            type="date"
            max={today}
            value={period.end}
            onChange={(e) => changePeriod({ ...period, end: e.target.value })}
          />
        </div>
        <p className="mt-2 text-xs text-subtle">
          Dagarna som utbetalningen gäller. Betalar Nayax varje vecka: välj veckan.
        </p>
      </details>
    </form>
  );
}
