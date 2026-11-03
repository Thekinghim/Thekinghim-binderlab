"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { formatNumber } from "@/lib/format";

import { VmbBeforeSplitMore } from "../../avtal/_components/vmb-before-split";
import { updateAgreement } from "../actions";
import type { AgreementView } from "../_lib/types";
import { FormDialog, text } from "./form-dialog";

/** 1 250 bp → "12,5" (som fältet visar det). */
function percentField(bp: number | null): string {
  if (bp === null) return "";
  return formatNumber(bp / 100, bp % 100 === 0 ? 0 : bp % 10 === 0 ? 1 : 2).replace(
    /[\s\u00a0]/g,
    "",
  );
}

/** 75 000 öre → "750", 75 050 → "750,50". */
function rentField(ore: number | null): string {
  if (ore === null) return "";
  return formatNumber(ore / 100, ore % 100 === 0 ? 0 : 2).replace(/[\s\u00a0]/g, "");
}

type Model = "split" | "sales";

const MODELS: { value: Model; label: string }[] = [
  { value: "split", label: "Vinstdelning 50/50" },
  { value: "sales", label: "Andel av försäljning" },
];

/**
 * Villkoren: vinstdelning 50/50 (hälften av vinsten efter inköp och kortavgifter; VMB-moms
 * dras bara om avtalets val är på) och valfri hyra. Valet "Andel av försäljning" visas bara för gamla avtal med den modellen,
 * så att de kan rättas till vinstdelning.
 */
function TermsFields({ agreement }: { agreement?: AgreementView }) {
  const legacy = agreement !== undefined && agreement.commissionBase !== "profit_after_costs";
  const [model, setModel] = useState<Model>(legacy ? "sales" : "split");
  // En vinstdelning med annan andel än 50 % behåller sin andel när den rättas.
  const keptShare =
    agreement?.commissionBase === "profit_after_costs" ? agreement.commissionBp : null;
  return (
    <div className="flex flex-col gap-4">
      <input type="hidden" name="model" value={model} />
      {legacy ? (
        <Segmented label="Ersättning" options={MODELS} value={model} onChange={setModel} />
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {model === "sales" ? (
          <Input
            name="commission"
            label="Andel"
            hint="Av försäljningen exkl. moms."
            inputMode="decimal"
            suffix="%"
            defaultValue={
              agreement?.commissionBase === "profit_after_costs"
                ? ""
                : percentField(agreement?.commissionBp ?? null)
            }
            autoComplete="off"
            className="tnum text-right"
          />
        ) : keptShare !== null && keptShare !== 5_000 ? (
          <input type="hidden" name="commission" value={percentField(keptShare)} />
        ) : null}
        <Input
          name="rent"
          label="Hyra per månad"
          hint="Valfri."
          inputMode="decimal"
          suffix="kr"
          defaultValue={rentField(agreement?.monthlyRentOre ?? null)}
          autoComplete="off"
          className="tnum text-right"
        />
      </div>
      {model === "split" ? (
        <VmbBeforeSplitMore
          id={`avtal-${agreement?.id ?? "nytt"}-vmb`}
          name="vmbBeforeSplit"
          checked={agreement?.vmbBeforeSplit ?? false}
        />
      ) : null}
    </div>
  );
}

/** "Ändra" på en avtalsrad: rätta villkor, anteckning eller sista dag. Ägare och admin. */
export function EditAgreementButton({
  agreement,
  storeName,
}: {
  agreement: AgreementView;
  storeName: string;
}) {
  const [open, setOpen] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const close = () => {
    setOpen(false);
    setNeedsConfirm(false);
  };
  const started = agreement.state !== "upcoming";
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Ändra avtalet ${agreement.periodLabel}`}
      >
        Ändra
      </Button>
      <FormDialog
        open={open}
        onClose={close}
        eyebrow={`Butiker / ${storeName} / Avtal`}
        title="Ändra avtal."
        description={
          started
            ? `Gäller ${agreement.periodLabel}. För att rätta fel; nya villkor görs med Skapa avtal.`
            : `Gäller ${agreement.periodLabel}.`
        }
        submitLabel={needsConfirm ? "Spara ändå" : "Spara"}
        onSubmit={async (data) => {
          const result = await updateAgreement({
            agreementId: agreement.id,
            validTo: text(data, "validTo"),
            model: text(data, "model"),
            commission: text(data, "commission"),
            rent: text(data, "rent"),
            note: text(data, "note"),
            ...(text(data, "model") === "split"
              ? { vmbBeforeSplit: data.get("vmbBeforeSplit") === "on" }
              : {}),
            confirmHistory: needsConfirm,
          });
          if (!result.ok) {
            if (result.needsConfirm) setNeedsConfirm(true);
            return result;
          }
          close();
          toast({ title: "Avtalet är ändrat", tone: "ok", meta: storeName });
          router.refresh();
          return { ok: true };
        }}
      >
        <TermsFields agreement={agreement} />
        <Input
          name="validTo"
          label="Sista dag"
          hint="Tom = tills vidare."
          type="date"
          min={agreement.validFrom}
          defaultValue={agreement.validTo ?? ""}
        />
        <Input
          name="note"
          label="Anteckning"
          defaultValue={agreement.note ?? ""}
          autoComplete="off"
          maxLength={500}
        />
      </FormDialog>
    </>
  );
}
