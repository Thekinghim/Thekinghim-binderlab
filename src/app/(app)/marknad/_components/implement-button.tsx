"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { implementAssortment } from "../actions";

/** Markerar en sortimentsrekommendation som genomförd från och med en dag. */
export function ImplementButton({
  machineId,
  machineCode,
  fingerprint,
  periodStart,
  periodEnd,
  today,
  summary,
  effectText,
}: {
  machineId: string;
  machineCode: string;
  fingerprint: string;
  periodStart: string;
  periodEnd: string;
  today: string;
  /** Ändringarna i en mening. */
  summary: string;
  effectText: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await implementAssortment({
        machineId,
        fingerprint,
        implementedOn: day,
        periodStart,
        periodEnd,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast({
        title: "Sortimentsändringen genomförd",
        description: "Uppföljningen räknas från genomförandedagen.",
        meta: machineCode,
        tone: "ok",
      });
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          setDay(today);
          setError(null);
          setOpen(true);
        }}
      >
        Markera som genomförd
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={`Sortiment / ${machineCode}`}
        title="Markera som genomförd"
        description={`${summary} Väntad effekt ${effectText}. Fackfördelningen uppdateras från och med dagen nedan och utfallet följs upp mot effekten.`}
        size="sm"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            label="Genomförd"
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            required
          />
          {error ? (
            <p role="alert" className="text-sm text-signal-fg">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
            <Button type="button" onClick={() => setOpen(false)}>
              Avbryt
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              Genomförd
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
