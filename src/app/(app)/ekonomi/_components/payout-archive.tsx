"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { archivePayout } from "../actions";
import { DialogButtons, FormError, TextArea } from "./bits";

/**
 * "Arkivera" en felaktigt importerad utbetalning, med anteckning om varför. Den räknas sedan
 * inte i avstämningen, bokföringen eller kassaflödet, och en rättad rad med samma referens kan
 * importeras. Utbetalningen raderas aldrig; arkiveringen loggas.
 */
export function PayoutArchive({ id, reference }: { id: string; reference: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const close = () => {
    setOpen(false);
    setNoteError(undefined);
    setError(undefined);
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = note.trim();
    if (!text) {
      setNoteError("Skriv varför utbetalningen arkiveras.");
      return;
    }
    setNoteError(undefined);
    setError(undefined);
    startTransition(async () => {
      const res = await archivePayout({ id, note: text });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast({
        title: `Utbetalning ${res.data.reference} arkiverad`,
        description: "Importera den rättade raden med samma referens.",
        tone: "ok",
      });
      setNote("");
      close();
      router.refresh();
    });
  };

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Arkivera
      </Button>
      <Modal
        open={open}
        onClose={close}
        eyebrow="Avstämning"
        title={`Arkivera utbetalning ${reference}`}
        description="Utbetalningen räknas inte längre och en rättad rad med samma referens kan importeras. Den raderas inte."
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <TextArea
            label="Varför arkiveras den"
            name="note"
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            error={noteError}
            hint="Sparas med utbetalningen och i ändringsloggen."
            autoFocus
          />
          <FormError message={error} />
          <DialogButtons>
            <Button type="button" onClick={close}>
              Avbryt
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              Arkivera
            </Button>
          </DialogButtons>
        </form>
      </Modal>
    </>
  );
}
