"use client";

import { useState, useTransition } from "react";

import { Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { AGREEMENT_FORM_LABEL, type AgreementForm } from "@/reports/store-basis";

import { setStoreAgreementForm } from "../actions";

type Choice = AgreementForm | "";

const HINT: Record<Choice, string> = {
  "": "Rapporten säger inte vilket avtal som gäller. Välj ett.",
  written: "Rapporten visar det undertecknade kontraktet.",
  oral: "Rapporten säger att avtalet är muntligt och skriver villkoren.",
};

/**
 * Avtalets form i butiksrapporten (ägare och admin): "Skriftligt avtal" eller "Muntligt
 * avtal". Inget valt: finns ett undertecknat kontrakt visas det (som Skriftligt avtal),
 * annars står inget avtal i rapporten och granskningen varnar. Muntligt går före ett kontrakt
 * som står som undertecknat. Gäller rapporter som skapas härefter.
 */
export function AgreementFormSelect({
  storeId,
  initial,
  signedContract,
  canEdit,
}: {
  storeId: string;
  initial: AgreementForm | null;
  /** Butiken har ett undertecknat kontrakt i dag. */
  signedContract: boolean;
  canEdit: boolean;
}) {
  const toast = useToast();
  // Inget valt och ett undertecknat kontrakt: rapporten visar kontraktet, alltså skriftligt.
  const shown = (v: AgreementForm | null): Choice => v ?? (signedContract ? "written" : "");
  const [value, setValue] = useState<Choice>(shown(initial));
  const [pending, start] = useTransition();

  function save(next: Choice) {
    const before = value;
    setValue(next);
    start(async () => {
      const res = await setStoreAgreementForm({ storeId, form: next === "" ? null : next });
      if (!res.ok) {
        setValue(before);
        toast({ title: "Sparades inte", description: res.error, tone: "critical" });
        return;
      }
      toast({
        title:
          next === "" ? "Klart! Ingen avtalsform vald." : `Klart! ${AGREEMENT_FORM_LABEL[next]}.`,
        description: "Gäller nästa rapport.",
        tone: "ok",
      });
    });
  }

  return (
    <div
      id="avtalsform"
      className="flex scroll-mt-24 flex-col gap-2 rounded-md border border-line-strong px-4 py-3"
    >
      <Select
        label="Avtalsform i rapporten"
        name="agreementForm"
        disabled={!canEdit || pending}
        options={[
          { value: "", label: "Inte valt" },
          { value: "written", label: AGREEMENT_FORM_LABEL.written },
          { value: "oral", label: AGREEMENT_FORM_LABEL.oral },
        ]}
        hint={
          value === "written" && !signedContract
            ? "Inget undertecknat kontrakt finns: rapporten säger inte vilket avtal som gäller."
            : value === "written" && initial === null
              ? "Från det undertecknade kontraktet. Rapporten visar det."
              : HINT[value]
        }
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          save(v === "written" || v === "oral" ? v : "");
        }}
      />
    </div>
  );
}
