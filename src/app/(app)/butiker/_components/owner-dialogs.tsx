"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { MOBILE_MENU_ITEM, MobileMore } from "@/components/ui/more-menu";
import { useToast } from "@/components/ui/toast";
import { vatFromOrgNumber } from "@/lib/swedish-ids";

import { createOwner, setOwnerArchived, setStoreOwner, updateOwner } from "../owner-actions";
import type { OwnerView } from "../_lib/owner-service";
import { FormDialog, text } from "./form-dialog";

/** Bolagets uppgifter (nytt eller befintligt). */
function OwnerFields({ owner }: { owner?: OwnerView }) {
  const idBase = useId();
  const [orgNumber, setOrgNumber] = useState(owner?.orgNumber ?? "");
  const [vat, setVat] = useState(owner?.vatNumber ?? "");
  // Förslaget ur organisationsnumret, bara som förslag: inte alla bolag är momsregistrerade.
  const suggestion = vatFromOrgNumber(orgNumber);
  const showSuggestion = suggestion !== null && vat.replace(/\s/g, "").toUpperCase() !== suggestion;
  return (
    <>
      <Input
        name="legalName"
        label="Bolagets namn"
        defaultValue={owner?.legalName ?? ""}
        placeholder="Godisbolaget AB"
        hint="Det juridiska namnet, som på fakturor och avtal."
        required
        autoComplete="off"
        maxLength={200}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          name="orgNumber"
          label="Organisationsnummer"
          value={orgNumber}
          onChange={(e) => setOrgNumber(e.target.value)}
          placeholder="NNNNNN-NNNN"
          required
          autoComplete="off"
          inputMode="numeric"
          maxLength={20}
        />
        <div className="flex min-w-0 flex-col gap-1.5">
          <Input
            name="vatNumber"
            label="Momsreg.nr (valfritt)"
            value={vat}
            onChange={(e) => setVat(e.target.value)}
            placeholder="SE NNNNNNNNNN 01"
            autoComplete="off"
            maxLength={20}
          />
          {showSuggestion ? (
            <button
              type="button"
              onClick={() => setVat(suggestion)}
              className="self-start rounded-xs text-xs text-muted underline decoration-line-strong underline-offset-4 hover:text-fg max-md:tap"
            >
              Använd {suggestion}
            </button>
          ) : null}
        </div>
      </div>
      <div className="flex items-start gap-3">
        <input
          id={`${idBase}-ftax`}
          type="checkbox"
          name="fTax"
          defaultChecked={owner?.fTax ?? false}
          className="mt-0.5 size-4 shrink-0 accent-current"
        />
        <label
          htmlFor={`${idBase}-ftax`}
          className="text-base text-fg max-md:-mt-3.5 max-md:-mb-2 max-md:tap"
        >
          Godkänd för F-skatt
        </label>
      </div>
      <Input
        name="streetAddress"
        label="Gatuadress"
        defaultValue={owner?.streetAddress ?? ""}
        autoComplete="off"
        maxLength={200}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
        <Input
          name="postalCode"
          label="Postnummer"
          defaultValue={owner?.postalCode ?? ""}
          placeholder="NNN NN"
          autoComplete="off"
          inputMode="numeric"
          maxLength={10}
        />
        <Input
          name="city"
          label="Ort"
          defaultValue={owner?.city ?? ""}
          autoComplete="off"
          maxLength={100}
        />
      </div>
      <Input
        name="contactName"
        label="Kontaktperson"
        defaultValue={owner?.contactName ?? ""}
        autoComplete="off"
        maxLength={200}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          name="email"
          label="E-post"
          type="email"
          defaultValue={owner?.email ?? ""}
          autoComplete="off"
          maxLength={254}
        />
        <Input
          name="phone"
          label="Telefon"
          type="tel"
          defaultValue={owner?.phone ?? ""}
          autoComplete="off"
          maxLength={50}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          name="invoiceEmail"
          label="Fakturor till (e-post)"
          type="email"
          defaultValue={owner?.invoiceEmail ?? ""}
          hint="Dit leverantörsfakturor skickas."
          autoComplete="off"
          maxLength={254}
        />
        <Input
          name="bankgiro"
          label="Bankgiro (valfritt)"
          defaultValue={owner?.bankgiro ?? ""}
          placeholder="NNN-NNNN"
          autoComplete="off"
          inputMode="numeric"
          maxLength={12}
        />
      </div>
      <Input
        name="note"
        label="Anteckning"
        defaultValue={owner?.note ?? ""}
        autoComplete="off"
        maxLength={2000}
      />
    </>
  );
}

function ownerInput(data: FormData) {
  return {
    legalName: text(data, "legalName"),
    orgNumber: text(data, "orgNumber"),
    vatNumber: text(data, "vatNumber"),
    fTax: data.get("fTax") === "on",
    streetAddress: text(data, "streetAddress"),
    postalCode: text(data, "postalCode"),
    city: text(data, "city"),
    contactName: text(data, "contactName"),
    email: text(data, "email"),
    phone: text(data, "phone"),
    invoiceEmail: text(data, "invoiceEmail"),
    bankgiro: text(data, "bankgiro"),
    note: text(data, "note"),
  };
}

/** Dialogen "Ny butiksägare". Med `storeId` blir ägaren också butikens ägare. */
function NewOwnerDialog({
  open,
  onClose,
  storeId,
  storeName,
}: {
  open: boolean;
  onClose: () => void;
  storeId?: string;
  storeName?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      eyebrow={storeName ? `Butiker / ${storeName}` : "Butiker / Butiksägare"}
      title="Ny butiksägare."
      description={
        storeName
          ? `Bolaget som äger ${storeName}. Det blir butikens ägare när du sparar.`
          : "Bolaget som äger en eller flera butiker."
      }
      submitLabel="Lägg till"
      onSubmit={async (data) => {
        const input = ownerInput(data);
        const result = await createOwner({ ...input, ...(storeId ? { storeId } : {}) });
        if (!result.ok) return result;
        onClose();
        toast({ title: `${input.legalName.trim()} är tillagd`, tone: "ok" });
        router.refresh();
        return { ok: true };
      }}
    >
      <OwnerFields />
    </FormDialog>
  );
}

/** Knappen "Ny butiksägare". Ägare och admin. */
export function AddOwnerButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" iconLeft="plus" onClick={() => setOpen(true)}>
        Ny butiksägare
      </Button>
      <NewOwnerDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Ändra, arkivera och återställ en butiksägare. Ägare och admin. */
export function OwnerActions({ owner }: { owner: OwnerView }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const activeStores = owner.stores.filter((s) => !s.archived);
  const blocked = !owner.archived && activeStores.length > 0;
  const closeConfirm = () => {
    if (pending) return;
    setConfirm(false);
    setError(null);
  };
  const archive = () =>
    startTransition(async () => {
      setError(null);
      const r = await setOwnerArchived({ ownerId: owner.id, archived: !owner.archived });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setConfirm(false);
      toast({
        title: owner.archived
          ? `${owner.legalName} är återställd`
          : `${owner.legalName} är arkiverad`,
        tone: "ok",
      });
      router.refresh();
    });
  return (
    <div className="flex flex-wrap gap-2">
      <MobileMore label={`Ändra ${owner.legalName}`} className="md:flex md:flex-wrap md:gap-2">
        {owner.archived ? null : (
          <Button
            variant="secondary"
            size="sm"
            className={MOBILE_MENU_ITEM}
            onClick={() => setOpen(true)}
          >
            Redigera
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          className={MOBILE_MENU_ITEM}
          onClick={() => setConfirm(true)}
        >
          {owner.archived ? "Återställ" : "Arkivera"}
        </Button>
      </MobileMore>
      <FormDialog
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={`Butiksägare / ${owner.legalName}`}
        title="Redigera butiksägare."
        submitLabel="Spara"
        onSubmit={async (data) => {
          const result = await updateOwner({ ownerId: owner.id, ...ownerInput(data) });
          if (!result.ok) return result;
          setOpen(false);
          toast({ title: "Butiksägaren är sparad", tone: "ok", meta: owner.legalName });
          router.refresh();
          return { ok: true };
        }}
      >
        <OwnerFields owner={owner} />
      </FormDialog>
      <Modal
        open={confirm}
        onClose={closeConfirm}
        size="sm"
        eyebrow={`Butiksägare / ${owner.legalName}`}
        title={owner.archived ? `Återställ ${owner.legalName}?` : `Arkivera ${owner.legalName}?`}
        description={
          owner.archived
            ? "Ägaren kan väljas för butiker och i filtret igen."
            : blocked
              ? `${activeStores.map((s) => s.name).join(", ")} har den här ägaren. Välj en annan ägare på ${activeStores.length === 1 ? "butikens" : "butikernas"} sida först.`
              : "Ägaren döljs i listorna och i filtret. Uppgifterna finns kvar, och du kan återställa ägaren."
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeConfirm} disabled={pending}>
              {blocked ? "Stäng" : "Avbryt"}
            </Button>
            {blocked ? null : (
              <Button
                variant={owner.archived ? "primary" : "danger-confirm"}
                loading={pending}
                onClick={archive}
              >
                {owner.archived ? "Återställ" : "Arkivera"}
              </Button>
            )}
          </>
        }
      >
        {error ? (
          <p role="alert" className="flex items-start gap-2 text-sm">
            <span aria-hidden className="mt-1.5 inline-block size-2 shrink-0 bg-signal" />
            <span className="text-fg">
              <span className="sr-only">Kräver åtgärd: </span>
              {error}
            </span>
          </p>
        ) : null}
      </Modal>
    </div>
  );
}

const NEW_OWNER = "__ny";

/**
 * Butikens ägare på butikens sida: välj bland de aktiva ägarna, ingen, eller "Ny ägare …"
 * (öppnar formuläret och kopplar den nya ägaren till butiken). Ägare och admin.
 */
export function StoreOwnerPicker({
  storeId,
  storeName,
  ownerId,
  owners,
}: {
  storeId: string;
  storeName: string;
  ownerId: string | null;
  owners: ReadonlyArray<{ id: string; legalName: string; orgNumber: string }>;
}) {
  const [value, setValue] = useState(ownerId ?? "");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const changed = value !== (ownerId ?? "");
  const save = () =>
    startTransition(async () => {
      setError(null);
      const r = await setStoreOwner({ storeId, ownerId: value });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const name = owners.find((o) => o.id === value)?.legalName;
      toast({
        title: name ? `${storeName} har ägaren ${name}` : `${storeName} har ingen ägare`,
        tone: "ok",
      });
      router.refresh();
    });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Select
          label="Ägare"
          value={value}
          wrapperClassName="min-w-0 sm:max-w-[360px] sm:flex-1"
          onChange={(e) => {
            if (e.target.value === NEW_OWNER) {
              setCreating(true);
              return;
            }
            setValue(e.target.value);
          }}
          options={[
            { value: "", label: "Ingen ägare" },
            ...owners.map((o) => ({ value: o.id, label: `${o.legalName} (${o.orgNumber})` })),
            { value: NEW_OWNER, label: "Ny ägare …" },
          ]}
        />
        {changed ? (
          <Button variant="primary" onClick={save} loading={pending} className="max-sm:w-full">
            Spara ägare
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="flex items-start gap-2 text-sm">
          <span aria-hidden className="mt-1.5 inline-block size-2 shrink-0 bg-signal" />
          <span className="text-fg">
            <span className="sr-only">Kräver åtgärd: </span>
            {error}
          </span>
        </p>
      ) : null}
      <NewOwnerDialog
        open={creating}
        onClose={() => setCreating(false)}
        storeId={storeId}
        storeName={storeName}
      />
    </div>
  );
}
