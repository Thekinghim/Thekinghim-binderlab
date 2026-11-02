"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import type { IsoDate } from "@/domain";
import { formatNumber } from "@/lib/format";

import { createAgreement, updateAgreement } from "../actions";
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

function TermsFields({ agreement }: { agreement?: AgreementView }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Input
        name="commission"
        label="Provision"
        hint="Andel av intäkten exkl. moms."
        inputMode="decimal"
        suffix="%"
        defaultValue={percentField(agreement?.commissionBp ?? null)}
        autoComplete="off"
        className="tnum text-right"
      />
      <Input
        name="rent"
        label="Hyra per månad"
        hint="Räknas per dag vid delmånad."
        inputMode="decimal"
        suffix="kr"
        defaultValue={rentField(agreement?.monthlyRentOre ?? null)}
        autoComplete="off"
        className="tnum text-right"
      />
    </div>
  );
}

/**
 * Bekräftelsen när en ändring räknar om passerad ersättning. Visas först när servern
 * har sagt vilka dagar och rapporter som berörs (felet ovanför knapparna).
 */
function ConfirmHistory() {
  const id = useId();
  return (
    <div className="flex items-start gap-3 border-t border-line pt-4">
      <input
        id={id}
        type="checkbox"
        name="confirmHistory"
        aria-describedby={`${id}-hint`}
        className="mt-0.5 size-4 shrink-0 accent-current"
      />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-base text-fg">
          Räkna om ersättningen bakåt i tiden
        </label>
        <p id={`${id}-hint`} className="text-sm text-muted">
          Hem, Lönsamhet och kommande rapporter visar de nya beloppen. Skickade rapporter ändras
          inte.
        </p>
      </div>
    </div>
  );
}

/** Knappen "Nytt avtal" med formulär. Ägare och admin. */
export function NewAgreementButton({
  storeId,
  storeName,
  today,
  current,
  minFrom,
}: {
  storeId: string;
  storeName: string;
  today: IsoDate;
  current: AgreementView | null;
  /** Dagen efter det senaste avtalets start, om det är senare än i dag. */
  minFrom: IsoDate | null;
}) {
  const [open, setOpen] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const from = minFrom && minFrom > today ? minFrom : today;
  const close = () => {
    setOpen(false);
    setNeedsConfirm(false);
  };
  return (
    <>
      <Button variant="secondary" size="sm" iconLeft="plus" onClick={() => setOpen(true)}>
        Nytt avtal
      </Button>
      <FormDialog
        open={open}
        onClose={close}
        eyebrow={`Butiker / ${storeName} / Nytt avtal`}
        title="Nytt avtal."
        description={
          current
            ? `Det gällande avtalet (${current.termsLabel.toLocaleLowerCase("sv-SE")}) avslutas dagen före det nya. Historiken sparas.`
            : "Ange provision, hyra eller båda."
        }
        submitLabel="Spara avtal"
        onSubmit={async (data) => {
          const result = await createAgreement({
            storeId,
            validFrom: text(data, "validFrom"),
            validTo: text(data, "validTo"),
            commission: text(data, "commission"),
            rent: text(data, "rent"),
            note: text(data, "note"),
            confirmHistory: data.get("confirmHistory") === "on",
          });
          if (!result.ok) {
            if (result.needsConfirm) setNeedsConfirm(true);
            return result;
          }
          close();
          toast({
            title: "Avtalet är sparat",
            description: result.data?.closedId ? "Det tidigare avtalet är avslutat." : undefined,
            tone: "ok",
            meta: storeName,
          });
          router.refresh();
          return { ok: true };
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input name="validFrom" label="Giltig från" type="date" defaultValue={from} required />
          <Input name="validTo" label="Sista dag" hint="Tom = tills vidare." type="date" />
        </div>
        <TermsFields agreement={current ?? undefined} />
        <Input name="note" label="Anteckning" autoComplete="off" maxLength={500} />
        {needsConfirm ? <ConfirmHistory /> : null}
      </FormDialog>
    </>
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
            ? `Gäller ${agreement.periodLabel}. Rätta bara fel i avtalet: ändrade villkor räknar om ersättningen bakåt till avtalets start. Nya villkor från ett datum läggs in som nytt avtal.`
            : `Gäller ${agreement.periodLabel}. Nya villkor från ett senare datum läggs in som nytt avtal.`
        }
        submitLabel="Spara"
        onSubmit={async (data) => {
          const result = await updateAgreement({
            agreementId: agreement.id,
            validTo: text(data, "validTo"),
            commission: text(data, "commission"),
            rent: text(data, "rent"),
            note: text(data, "note"),
            confirmHistory: data.get("confirmHistory") === "on",
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
        {needsConfirm ? <ConfirmHistory /> : null}
      </FormDialog>
    </>
  );
}
