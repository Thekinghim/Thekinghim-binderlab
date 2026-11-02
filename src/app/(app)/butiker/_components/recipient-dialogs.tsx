"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { createStoreRecipient, deleteStoreRecipient, updateStoreRecipient } from "../actions";
import type { RecipientView } from "../_lib/types";
import { FormDialog, text } from "./form-dialog";

function RecipientFields({ recipient }: { recipient?: RecipientView }) {
  return (
    <>
      <Input
        name="name"
        label="Namn"
        defaultValue={recipient?.name ?? ""}
        required
        autoComplete="off"
        maxLength={200}
      />
      <Input
        name="email"
        label="E-post"
        type="email"
        defaultValue={recipient?.email ?? ""}
        required
        autoComplete="off"
        maxLength={320}
      />
    </>
  );
}

/** Knappen "Lägg till mottagare". Ägare och admin. */
export function AddRecipientButton({
  storeId,
  storeName,
  defaults,
}: {
  storeId: string;
  storeName: string;
  /** Butikens kontaktperson som förslag. */
  defaults: { name: string; email: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const toast = useToast();
  return (
    <>
      <Button variant="secondary" size="sm" iconLeft="plus" onClick={() => setOpen(true)}>
        Lägg till mottagare
      </Button>
      <FormDialog
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={`Butiker / ${storeName} / Mottagare`}
        title="Lägg till mottagare."
        description="Mottagaren får butikens månadsrapport när den godkänts under Rapporter."
        submitLabel="Lägg till"
        onSubmit={async (data) => {
          const result = await createStoreRecipient({
            storeId,
            name: text(data, "name"),
            email: text(data, "email"),
          });
          if (!result.ok) return result;
          setOpen(false);
          toast({ title: "Mottagaren är tillagd", tone: "ok", meta: text(data, "email") });
          router.refresh();
          return { ok: true };
        }}
      >
        <RecipientFields
          recipient={
            defaults
              ? {
                  id: "",
                  name: defaults.name,
                  email: defaults.email,
                  active: true,
                  lastSentAt: null,
                }
              : undefined
          }
        />
      </FormDialog>
    </>
  );
}

/** Ändra, pausa och ta bort på en mottagarrad. Ägare och admin. */
export function RecipientActions({ recipient }: { recipient: RecipientView }) {
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const toggle = () =>
    start(async () => {
      const r = await updateStoreRecipient({
        recipientId: recipient.id,
        name: recipient.name,
        email: recipient.email,
        active: !recipient.active,
      });
      if (r.ok) {
        toast({
          title: recipient.active ? "Mottagaren är pausad" : "Mottagaren är aktiv igen",
          tone: "ok",
          meta: recipient.email,
        });
        router.refresh();
      } else {
        toast({ title: r.error, tone: "critical", meta: recipient.email });
      }
    });
  const remove = () =>
    start(async () => {
      const r = await deleteStoreRecipient({ recipientId: recipient.id });
      setDialog(null);
      if (r.ok) {
        toast({ title: "Mottagaren är borttagen", tone: "ok", meta: recipient.email });
        router.refresh();
      } else {
        toast({ title: r.error, tone: "critical", meta: recipient.email });
      }
    });

  return (
    <div className="flex justify-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDialog("edit")}
        aria-label={`Ändra ${recipient.name}`}
      >
        Ändra
      </Button>
      <Button
        variant="ghost"
        size="sm"
        loading={pending && dialog === null}
        onClick={toggle}
        aria-label={`${recipient.active ? "Pausa" : "Aktivera"} ${recipient.name}`}
      >
        {recipient.active ? "Pausa" : "Aktivera"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDialog("delete")}
        aria-label={`Ta bort ${recipient.name}`}
      >
        Ta bort
      </Button>

      <FormDialog
        open={dialog === "edit"}
        onClose={() => setDialog(null)}
        eyebrow="Butiker / Mottagare"
        title="Ändra mottagare."
        submitLabel="Spara"
        onSubmit={async (data) => {
          const result = await updateStoreRecipient({
            recipientId: recipient.id,
            name: text(data, "name"),
            email: text(data, "email"),
            active: recipient.active,
          });
          if (!result.ok) return result;
          setDialog(null);
          toast({ title: "Mottagaren är sparad", tone: "ok", meta: text(data, "email") });
          router.refresh();
          return { ok: true };
        }}
      >
        <RecipientFields recipient={recipient} />
      </FormDialog>

      <Modal
        open={dialog === "delete"}
        onClose={() => (pending ? undefined : setDialog(null))}
        eyebrow="Butiker / Mottagare"
        title={`Ta bort ${recipient.name}?`}
        description={`${recipient.email} får inga fler rapporter för butiken. En mottagare som redan fått rapporter kan bara pausas.`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={pending}>
              Avbryt
            </Button>
            <Button variant="danger-confirm" loading={pending} onClick={remove}>
              Ta bort
            </Button>
          </>
        }
      />
    </div>
  );
}
