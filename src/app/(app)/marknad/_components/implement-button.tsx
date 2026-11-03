"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, formError } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { dayText } from "@/server/market/display";

import { implementAssortment } from "../actions";
import { latestDay, replacedStarts, shiftDay } from "../_lib/dates";

/** Markerar en sortimentsrekommendation som genomförd från och med en dag. */
export function ImplementButton({
  machineId,
  machineCode,
  fingerprint,
  periodStart,
  periodEnd,
  today,
  lockedThrough,
  starts,
  summary,
  effectText,
}: {
  machineId: string;
  machineCode: string;
  fingerprint: string;
  periodStart: string;
  periodEnd: string;
  today: string;
  /** Senaste genomförda sortimentsändring i automaten, eller null. */
  lockedThrough: string | null;
  /** Startdagar för automatens fackperioder. */
  starts: readonly string[];
  /** Ändringarna i en mening. */
  summary: string;
  effectText: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  // Tidigast dagen efter mätperioden, högst 7 dagar bakåt och efter en tidigare ändring.
  const minDay = latestDay(
    shiftDay(periodEnd, 1),
    shiftDay(today, -7),
    lockedThrough ? shiftDay(lockedThrough, 1) : null,
  )!;
  const defaultDay = minDay > today ? minDay : today;
  const [day, setDay] = useState(defaultDay);
  const replaced = replacedStarts(starts, day);
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
          setDay(defaultDay);
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
        description={`${summary} Väntad effekt ${effectText}.`}
        size="sm"
      >
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const invalid = formError(e.currentTarget);
            if (invalid) return setError(invalid);
            submit();
          }}
        >
          <Input
            label="Genomförd"
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            min={minDay}
            max={shiftDay(today, 30)}
            required
            hint={`${dayText(minDay, today)} till ${dayText(shiftDay(today, 30), today)}.`}
          />
          {replaced.length > 0 ? (
            <p className="text-sm text-fg" role="status">
              {`Fackfördelningen som börjar ${replaced.map((d) => dayText(d, today)).join(", ")} ersätts av rekommendationen.`}
            </p>
          ) : null}
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
