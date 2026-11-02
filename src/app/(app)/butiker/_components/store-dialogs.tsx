"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";

import { createStore, setStoreArchived, updateStore } from "../actions";
import type { StoreDetail } from "../_lib/types";
import { FormDialog, text } from "./form-dialog";

/** Fälten för en butik (nytt eller befintligt värde). */
function StoreFields({ store }: { store?: StoreDetail }) {
  const idBase = useId();
  return (
    <>
      <Input
        name="name"
        label="Namn"
        defaultValue={store?.name ?? ""}
        placeholder="ICA Kvantum Lund"
        required
        autoComplete="off"
        maxLength={200}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr]">
        <Input
          name="address"
          label="Adress"
          defaultValue={store?.address ?? ""}
          autoComplete="off"
          maxLength={300}
        />
        <Input
          name="city"
          label="Ort"
          defaultValue={store?.city ?? ""}
          autoComplete="off"
          maxLength={100}
        />
      </div>
      <Input
        name="contactName"
        label="Kontaktperson"
        defaultValue={store?.contactName ?? ""}
        autoComplete="off"
        maxLength={200}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          name="email"
          label="E-post"
          type="email"
          defaultValue={store?.email ?? ""}
          autoComplete="off"
          maxLength={320}
        />
        <Input
          name="phone"
          label="Telefon"
          type="tel"
          defaultValue={store?.phone ?? ""}
          autoComplete="off"
          maxLength={50}
        />
      </div>
      <div className="flex items-start gap-3">
        <input
          id={`${idBase}-example`}
          type="checkbox"
          name="isExample"
          defaultChecked={store?.isExample ?? false}
          aria-describedby={`${idBase}-example-hint`}
          className="mt-0.5 size-4 shrink-0 accent-current"
        />
        <div className="flex flex-col gap-0.5">
          <label htmlFor={`${idBase}-example`} className="text-base text-fg">
            Exempelbutik
          </label>
          <p id={`${idBase}-example-hint`} className="text-sm text-muted">
            Visas med etiketten Exempel i listor och rapporter.
          </p>
        </div>
      </div>
    </>
  );
}

function storeInput(data: FormData) {
  return {
    name: text(data, "name"),
    address: text(data, "address"),
    city: text(data, "city"),
    contactName: text(data, "contactName"),
    email: text(data, "email"),
    phone: text(data, "phone"),
    isExample: data.get("isExample") === "on",
  };
}

/** Knappen "Lägg till butik" med formulär. Ägare och admin. */
export function AddStoreButton({ query }: { query: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const toast = useToast();
  return (
    <>
      <Button variant="primary" iconLeft="plus" onClick={() => setOpen(true)}>
        Lägg till butik
      </Button>
      <FormDialog
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Butiker / Ny"
        title="Lägg till butik."
        description="Ersättningen läggs in som avtal på butikens sida."
        submitLabel="Lägg till"
        onSubmit={async (data) => {
          const input = storeInput(data);
          const result = await createStore(input);
          if (!result.ok) return result;
          setOpen(false);
          toast({ title: `${input.name.trim()} är tillagd`, tone: "ok" });
          if (result.data) router.push(`/butiker/${result.data.id}${query}`);
          return { ok: true };
        }}
      >
        <StoreFields />
      </FormDialog>
    </>
  );
}

/** Redigera och arkivera på butikens sida. Ägare och admin. */
export function StoreActions({ store }: { store: StoreDetail }) {
  const [open, setOpen] = useState(false);
  const [archiving, startArchive] = useTransition();
  const router = useRouter();
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2" data-print="hide">
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Redigera
      </Button>
      <Button
        variant="secondary"
        size="sm"
        loading={archiving}
        onClick={() =>
          startArchive(async () => {
            const r = await setStoreArchived({ storeId: store.id, archived: !store.archived });
            if (r.ok) {
              toast({
                title: store.archived ? `${store.name} är återställd` : `${store.name} är arkiverad`,
                tone: "ok",
              });
              router.refresh();
            } else {
              toast({ title: r.error, tone: "critical", meta: store.name });
            }
          })
        }
      >
        {store.archived ? "Återställ" : "Arkivera"}
      </Button>
      <FormDialog
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={`Butiker / ${store.name}`}
        title="Redigera butik."
        submitLabel="Spara"
        onSubmit={async (data) => {
          const result = await updateStore({ storeId: store.id, ...storeInput(data) });
          if (!result.ok) return result;
          setOpen(false);
          toast({ title: "Butiken är sparad", tone: "ok", meta: store.name });
          router.refresh();
          return { ok: true };
        }}
      >
        <StoreFields store={store} />
      </FormDialog>
    </div>
  );
}
