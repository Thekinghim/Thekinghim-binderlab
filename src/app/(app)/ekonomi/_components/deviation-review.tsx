"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { reviewDeviation } from "../actions";
import { DialogButtons, FormError, TextArea } from "./bits";

/**
 * "Markera som utredd" (med anteckning om vad utredningen kom fram till) eller "Öppna igen".
 * Servern räknar om avvikelsen för perioden och sparar sitt eget fingerprint; ändras
 * avvikelsen senare gäller inte utredningen längre.
 */
export function DeviationReview({
  deviationKey,
  title,
  period,
  investigated,
}: {
  deviationKey: string;
  title: string;
  period: { start: string; end: string };
  investigated: boolean;
}) {
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

  const send = (action: "investigated" | "reopened", text: string | null) => {
    startTransition(async () => {
      const res = await reviewDeviation({
        start: period.start,
        end: period.end,
        key: deviationKey,
        action,
        note: text,
      });
      if (!res.ok) {
        if (action === "investigated") setError(res.error);
        else
          toast({ title: "Kunde inte öppna avvikelsen", description: res.error, tone: "critical" });
        return;
      }
      toast({
        title:
          action === "investigated" ? "Avvikelsen markerad som utredd" : "Avvikelsen öppnad igen",
        description: title,
        tone: "ok",
      });
      setNote("");
      close();
      router.refresh();
    });
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = note.trim();
    if (!text) {
      setNoteError("Skriv vad utredningen kom fram till.");
      return;
    }
    setNoteError(undefined);
    setError(undefined);
    send("investigated", text);
  };

  if (investigated) {
    return (
      <Button size="sm" variant="ghost" loading={pending} onClick={() => send("reopened", null)}>
        Öppna igen
      </Button>
    );
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Markera som utredd
      </Button>
      <Modal
        open={open}
        onClose={close}
        eyebrow="Avstämning"
        title="Markera som utredd"
        description={title}
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <TextArea
            label="Vad kom utredningen fram till"
            name="note"
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            error={noteError}
            hint="Sparas i loggen med namn och tid."
            autoFocus
          />
          <FormError message={error} />
          <DialogButtons>
            <Button type="button" onClick={close}>
              Avbryt
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              Markera som utredd
            </Button>
          </DialogButtons>
        </form>
      </Modal>
    </>
  );
}
