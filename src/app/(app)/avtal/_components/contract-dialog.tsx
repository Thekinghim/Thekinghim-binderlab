"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { DialogButtons, FormError, TextArea } from "../../ekonomi/_components/bits";
import { saveContract } from "../actions";
import type { AgreementOption, ContractDraft } from "../_lib/types";

const EMPTY: ContractDraft = {
  id: null,
  storeId: "",
  title: "",
  validFrom: "",
  validTo: "",
  noticePeriodMonths: "",
  noticePeriodDays: "",
  renewalMonths: "",
  terminatedOn: "",
  terms: "",
  note: "",
  agreementIds: [],
};

/**
 * Dialogen för nytt eller ändrat avtal: butik, giltighet, uppsägningstid, förlängning,
 * villkor i text, och ersättningen (befintliga villkor att koppla; nya villkor sätts under
 * Butiker eller med Skapa avtal, så att de blir vinstdelning).
 */
export function ContractDialog({
  stores,
  agreements,
  initial,
  trigger,
}: {
  stores: { id: string; name: string }[];
  agreements: AgreementOption[];
  initial?: ContractDraft;
  trigger: { label: string; variant?: "primary" | "secondary" | "ghost"; size?: "sm" | "md" };
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ContractDraft>(initial ?? EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof ContractDraft, string>>>({});
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const openDialog = () => {
    setDraft(initial ?? { ...EMPTY, storeId: stores[0]?.id ?? "" });
    setErrors({});
    setError(undefined);
    setOpen(true);
  };

  const storeAgreements = agreements.filter(
    (a) => a.storeId === draft.storeId && (a.contractId === null || a.contractId === draft.id),
  );

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const errs: Partial<Record<keyof ContractDraft, string>> = {};
    if (!draft.storeId) errs.storeId = "Välj en butik.";
    if (!draft.validFrom) errs.validFrom = "Ange när avtalet börjar gälla.";
    if (draft.validTo && draft.validFrom && draft.validTo < draft.validFrom)
      errs.validTo = "Slutdagen ligger före startdagen.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setError(undefined);
    startTransition(async () => {
      const res = await saveContract(draft);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast({
        title: draft.id ? "Avtalet ändrat" : "Avtalet sparat",
        description: stores.find((s) => s.id === draft.storeId)?.name,
        tone: "ok",
      });
      setOpen(false);
      router.refresh();
    });
  };

  const set = <K extends keyof ContractDraft>(key: K, value: ContractDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <>
      <Button
        variant={trigger.variant ?? "secondary"}
        size={trigger.size ?? "md"}
        iconLeft={initial ? undefined : "plus"}
        onClick={openDialog}
      >
        {trigger.label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Avtal"
        title={draft.id ? "Ändra avtal" : "Nytt avtal"}
        description="Påminnelse 90 d före sista uppsägningsdag."
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label="Butik"
              value={draft.storeId}
              options={[
                ...(draft.storeId ? [] : [{ value: "", label: "Välj butik" }]),
                ...stores.map((s) => ({ value: s.id, label: s.name })),
              ]}
              onChange={(e) =>
                setDraft((d) => ({ ...d, storeId: e.target.value, agreementIds: [] }))
              }
              error={errors.storeId}
            />
            <Input
              label="Rubrik"
              value={draft.title}
              maxLength={200}
              placeholder="Placeringsavtal"
              onChange={(e) => set("title", e.target.value)}
            />
            <Input
              label="Gäller från"
              type="date"
              value={draft.validFrom}
              onChange={(e) => set("validFrom", e.target.value)}
              error={errors.validFrom}
            />
            <Input
              label="Gäller till"
              type="date"
              hint="Tomt = tills vidare."
              value={draft.validTo}
              onChange={(e) => set("validTo", e.target.value)}
              error={errors.validTo}
            />
            <Input
              label="Uppsägningstid"
              inputMode="numeric"
              suffix="mån"
              value={draft.noticePeriodMonths}
              onChange={(e) => set("noticePeriodMonths", e.target.value)}
            />
            <Input
              label="Och dagar"
              inputMode="numeric"
              suffix="d"
              value={draft.noticePeriodDays}
              onChange={(e) => set("noticePeriodDays", e.target.value)}
            />
            <Input
              label="Förlängs automatiskt med"
              inputMode="numeric"
              suffix="mån"
              hint="Tomt = förlängs inte."
              value={draft.renewalMonths}
              onChange={(e) => set("renewalMonths", e.target.value)}
            />
            <Input
              label="Uppsagt den"
              type="date"
              hint="Tomt = inte uppsagt."
              value={draft.terminatedOn}
              onChange={(e) => set("terminatedOn", e.target.value)}
            />
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="label mb-2 text-muted">Ersättning till butiken</legend>
            {storeAgreements.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {storeAgreements.map((a) => {
                  const checked = draft.agreementIds.includes(a.id);
                  return (
                    <li key={a.id}>
                      <label className="flex items-start gap-3 text-sm text-fg">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 accent-current"
                          checked={checked}
                          onChange={() =>
                            set(
                              "agreementIds",
                              checked
                                ? draft.agreementIds.filter((x) => x !== a.id)
                                : [...draft.agreementIds, a.id],
                            )
                          }
                        />
                        <span className="flex flex-col gap-0.5">
                          <span>{a.label}</span>
                          <span className="meta text-subtle">{a.period}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted">
                Inga lediga villkor. Villkoren sätts under Butiker.
              </p>
            )}
          </fieldset>

          <TextArea
            label="Villkor"
            value={draft.terms}
            maxLength={4000}
            onChange={(e) => set("terms", e.target.value)}
            placeholder="Exklusivitet, placering i butiken, el, försäkring …"
          />
          <FormError message={error} />
          <DialogButtons>
            <Button type="button" onClick={() => setOpen(false)}>
              Avbryt
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              Spara avtal
            </Button>
          </DialogButtons>
        </form>
      </Modal>
    </>
  );
}
