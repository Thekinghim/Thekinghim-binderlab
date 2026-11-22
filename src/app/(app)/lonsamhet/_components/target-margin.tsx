"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";

import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/v2/button";
import { formatMarginBp } from "@/lib/format";

import { setTargetMargin } from "../actions";
import { parseTargetPercent } from "../_lib/advice-text";

/** Målet för marginalen: "Mål: 25 %" och "Ändra" för ägare och admin. */
export function TargetMarginControl({ targetBp, canEdit }: { targetBp: number; canEdit: boolean }) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(Math.round(targetBp / 100)));
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const bp = parseTargetPercent(value);
    if (bp === null) {
      setError("Ange ett mål mellan 1 och 90 procent.");
      return;
    }
    start(async () => {
      const res = await setTargetMargin({ targetMarginBp: bp }).catch(() => ({
        ok: false as const,
        error: "Ingen uppkoppling. Försök igen.",
      }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast({ title: `Målet är ${formatMarginBp(bp, 0)}.`, tone: "ok" });
      setOpen(false);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="tnum text-v2-md text-v2-ink">Mål: {formatMarginBp(targetBp, 0)} marginal</p>
        {canEdit ? (
          <Button
            size="sm"
            touch
            onClick={() => {
              setValue(String(Math.round(targetBp / 100)));
              setError(undefined);
              setOpen(true);
            }}
          >
            Ändra mål
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <form onSubmit={submit} noValidate className="v2-field">
      <label htmlFor={`${id}-mal`}>Mål för marginalen</label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="v2-input-wrap w-28">
          <input
            id={`${id}-mal`}
            inputMode="numeric"
            autoComplete="off"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(undefined);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-fel` : undefined}
            className="v2-input num"
          />
          <span className="sfx" aria-hidden="true">
            %
          </span>
        </span>
        <Button type="submit" variant="act" touch pending={pending}>
          Spara
        </Button>
        <Button disabled={pending} touch onClick={() => setOpen(false)}>
          Avbryt
        </Button>
      </div>
      {error ? (
        <p id={`${id}-fel`} role="alert" className="err">
          {error}
        </p>
      ) : null}
    </form>
  );
}
