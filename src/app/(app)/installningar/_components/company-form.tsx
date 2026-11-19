"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import {
  REPORT_VAT_MODE_LABEL,
  suggestedVatNumber,
  type ReportVatMode,
} from "@/reports/store-basis";

import { updateCompanyDetails } from "../_actions/settings";

export interface CompanyValues {
  readonly companyName: string;
  readonly orgNumber: string;
  readonly companyAddress: string;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  /** Momsregistreringsnummer i butiksrapporten, tomt = visas inte. */
  readonly vatNumber: string;
  /** Momsen i butiksrapporten. */
  readonly reportVatMode: ReportVatMode;
  /** "Vi säljer med vinstmarginalbeskattning (VMB)": rapporten säger det. */
  readonly reportVmb: boolean;
  /** "Vi äger och driver automaterna i butikerna": rapporten säger det. */
  readonly reportOwnsMachines: boolean;
}

type TextKey = Exclude<keyof CompanyValues, "reportVatMode" | "reportVmb" | "reportOwnsMachines">;

const VAT_MODES: Array<{ value: ReportVatMode; label: string }> = [
  { value: "added", label: REPORT_VAT_MODE_LABEL.added },
  { value: "none", label: REPORT_VAT_MODE_LABEL.none },
];

const FIELDS: ReadonlyArray<{
  key: TextKey;
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

/**
 * Våra företagsuppgifter, som står i varje kontrakt och i butiksrapporten (där de visar
 * butikens revisor vilket bolag som betalar). Ägare och admin.
 *
 * Momsregistreringsnumret föreslås från organisationsnumret (SE + tio siffror + 01), men
 * fylls bara i när man trycker på förslaget: det sparas aldrig utan att någon har valt det.
 */
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
        description: result.data?.changed
          ? "De står i nya kontrakt och rapporter direkt."
          : undefined,
        tone: result.data?.changed ? "ok" : "neutral",
      });
      router.refresh();
    });
  };

  const suggestion = suggestedVatNumber(values.orgNumber);
  const offer = values.vatNumber.trim() === "" ? suggestion : null;

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
        <div className="flex min-w-0 flex-col gap-2">
          <Input
            label="Momsregistreringsnummer"
            name="vatNumber"
            autoComplete="off"
            placeholder="SE559000123401"
            hint="Visas i butiksrapporten. Tomt = visas inte."
            value={values.vatNumber}
            onChange={(e) => {
              setValues({ ...values, vatNumber: e.target.value });
              setError(undefined);
            }}
          />
          {offer ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setValues({ ...values, vatNumber: offer });
                  setError(undefined);
                }}
              >
                Använd {offer}
              </Button>
            </div>
          ) : null}
        </div>
        <Select
          label="Moms i butiksrapporten"
          name="reportVatMode"
          options={VAT_MODES}
          hint={
            values.reportVatMode === "added"
              ? "Rapporten visar ersättningen, momsen och beloppet att fakturera."
              : "Rapporten visar bara ersättningen."
          }
          value={values.reportVatMode}
          onChange={(e) => {
            setValues({
              ...values,
              reportVatMode: e.target.value === "none" ? "none" : "added",
            });
            setError(undefined);
          }}
        />
        {/* Ägaren säger själv hur bolaget redovisar momsen: appen kan inte veta det. */}
        <ReportSwitch
          id="report-vmb-label"
          label="Vi säljer med vinstmarginalbeskattning (VMB)"
          hint={
            values.reportVmb
              ? "Butiksrapporten säger att vi redovisar momsen på försäljningen enligt VMB. VMB gäller bara begagnade varor, konst, samlarföremål och antikviteter: fråga revisorn om det gäller era varor."
              : "Av: butiksrapporten säger bara att vi är säljare av varorna."
          }
          checked={values.reportVmb}
          onToggle={() => {
            setValues({ ...values, reportVmb: !values.reportVmb });
            setError(undefined);
          }}
        />
        {/* Vem som äger automaten: appen vet det inte, så ägaren säger det. */}
        <ReportSwitch
          id="report-owns-label"
          label="Vi äger och driver automaterna i butikerna"
          hint={
            values.reportOwnsMachines
              ? "Butiksrapporten säger att bolaget äger och driver automaten."
              : "Av: butiksrapporten säger inget om vem som äger automaten."
          }
          checked={values.reportOwnsMachines}
          onToggle={() => {
            setValues({ ...values, reportOwnsMachines: !values.reportOwnsMachines });
            setError(undefined);
          }}
        />
      </div>
      <p className="border-t border-line pt-4 text-sm text-muted">
        Står i varje nytt kontrakt och i nya butiksrapporter.
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

/** En brytare för ett val i butiksrapporten, med en rad om vad den gör. */
function ReportSwitch({
  id,
  label,
  hint,
  checked,
  onToggle,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-line-strong px-4 py-3 sm:col-span-2">
      <span className="flex min-w-0 flex-col">
        <span id={id} className="text-base text-fg">
          {label}
        </span>
        <span className="meta text-subtle">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        onClick={onToggle}
        className={cn(
          "relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border transition-colors duration-fast ease-instrument max-md:before:absolute max-md:before:inset-x-0 max-md:before:-inset-y-1.5 max-md:before:content-['']",
          checked ? "border-up bg-up" : "border-line-control bg-raised",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "shadow inline-block size-6 rounded-full bg-fg transition-transform duration-fast ease-instrument",
            checked ? "translate-x-7 bg-bg" : "translate-x-1",
          )}
        />
      </button>
    </div>
  );
}
