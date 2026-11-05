"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

import { savePlan } from "../actions";

export interface PlanFormValues {
  effectiveFrom: string;
  status: string;
  price: string;
  currency: string;
  trialEndsOn: string;
  countryCode: string;
  vatNumber: string;
  note: string;
}

const STATUS_OPTIONS = [
  { value: "active", label: "Aktiv (debiteras)" },
  { value: "paused", label: "Pausad" },
  { value: "ended", label: "Avslutad" },
];

const CURRENCY_OPTIONS = ["SEK", "EUR", "DKK", "NOK"].map((c) => ({ value: c, label: c }));

/** Kundens plan och fakturauppgifter. Bara plattformsoperatörer (kontrolleras på servern). */
export function PlanForm({
  organizationId,
  customerName,
  initial,
  hasPlan,
}: {
  organizationId: string;
  customerName: string;
  initial: PlanFormValues;
  hasPlan: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState<PlanFormValues>(initial);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const set = (key: keyof PlanFormValues) => (value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setError(undefined);
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(undefined);
    startTransition(async () => {
      const result = await savePlan({ organizationId, ...values });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({ title: `Planen för ${customerName} sparad`, tone: "ok" });
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-5"
      aria-label={`Plan för ${customerName}`}
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          label="Gäller från"
          type="date"
          name="effectiveFrom"
          value={values.effectiveFrom}
          onChange={(e) => set("effectiveFrom")(e.target.value)}
          hint={hasPlan ? "Ny period från dagen" : undefined}
        />
        <Select
          label="Status"
          name="status"
          options={STATUS_OPTIONS}
          value={values.status}
          onChange={(e) => set("status")(e.target.value)}
        />
        <Input
          label="Pris per automat och månad"
          name="price"
          inputMode="decimal"
          suffix={values.currency === "SEK" ? "kr" : values.currency}
          value={values.price}
          onChange={(e) => set("price")(e.target.value)}
        />
        <Select
          label="Valuta"
          name="currency"
          options={CURRENCY_OPTIONS}
          value={values.currency}
          onChange={(e) => set("currency")(e.target.value)}
        />
        <Input
          label="Provperiod till och med"
          type="date"
          name="trialEndsOn"
          value={values.trialEndsOn}
          onChange={(e) => set("trialEndsOn")(e.target.value)}
          hint="Tomt = ingen provperiod"
        />
        <Input
          label="Land"
          name="countryCode"
          maxLength={2}
          autoCapitalize="characters"
          placeholder="SE"
          value={values.countryCode}
          onChange={(e) => set("countryCode")(e.target.value)}
        />
        <Input
          label="Momsnummer (EU)"
          name="vatNumber"
          autoCapitalize="characters"
          placeholder="DK12345678"
          value={values.vatNumber}
          onChange={(e) => set("vatNumber")(e.target.value)}
        />
        <Input
          label="Anteckning (bara här)"
          name="note"
          maxLength={500}
          value={values.note}
          onChange={(e) => set("note")(e.target.value)}
        />
      </div>
      <FormError message={error} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={pending}>
          Spara plan
        </Button>
      </div>
    </form>
  );
}
