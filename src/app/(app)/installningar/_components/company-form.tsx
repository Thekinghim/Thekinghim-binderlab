"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

import { updateCompanyDetails } from "../_actions/settings";

export interface CompanyValues {
  readonly companyName: string;
  readonly orgNumber: string;
  readonly companyAddress: string;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
}

const FIELDS: ReadonlyArray<{
  key: keyof CompanyValues;
  label: string;
  autoComplete: string;
  type?: string;
  inputMode?: "tel" | "email" | "numeric";
  placeholder?: string;
  wide?: boolean;
}> = [
  { key: "companyName", label: "Företagsnamn", autoComplete: "organization" },
  {
    key: "orgNumber",
    label: "Organisationsnummer",
    autoComplete: "off",
    inputMode: "numeric",
    placeholder: "559000-1234",
  },
  {
    key: "companyAddress",
    label: "Adress",
    autoComplete: "street-address",
    placeholder: "Gata 1, 123 45 Ort",
    wide: true,
  },
  { key: "contactName", label: "Kontaktperson", autoComplete: "name" },
  { key: "contactPhone", label: "Telefon", autoComplete: "tel", type: "tel", inputMode: "tel" },
  {
    key: "contactEmail",
    label: "E-post",
    autoComplete: "email",
    type: "email",
    inputMode: "email",
    wide: true,
  },
];

/** Våra företagsuppgifter, som står i varje kontrakt. Ägare och admin. */
export function CompanyForm({
  initial,
  organizationName,
}: {
  initial: CompanyValues;
  organizationName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState<CompanyValues>(initial);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(undefined);
    startTransition(async () => {
      const result = await updateCompanyDetails(values);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        title: result.data?.changed ? "Företagsuppgifterna sparade" : "Inget att spara",
        description: result.data?.changed ? "De står i nya kontrakt direkt." : undefined,
        tone: result.data?.changed ? "ok" : "neutral",
      });
      router.refresh();
    });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5" aria-label="Företaget">
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Input
            key={f.key}
            label={f.label}
            name={f.key}
            type={f.type ?? "text"}
            inputMode={f.inputMode}
            autoComplete={f.autoComplete}
            placeholder={f.key === "companyName" ? organizationName : f.placeholder}
            value={values[f.key]}
            wrapperClassName={f.wide ? "sm:col-span-2" : undefined}
            onChange={(e) => {
              setValues({ ...values, [f.key]: e.target.value });
              setError(undefined);
            }}
          />
        ))}
      </div>
      <p className="border-t border-line pt-4 text-sm text-muted">Står i varje nytt kontrakt.</p>
      <FormError message={error} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={pending}>
          Spara
        </Button>
      </div>
    </form>
  );
}
