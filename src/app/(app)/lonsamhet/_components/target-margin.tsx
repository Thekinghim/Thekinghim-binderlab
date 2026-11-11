"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";

import { useToast } from "@/components/ui/toast";
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="tnum text-base text-fg">Mål: {formatMarginBp(targetBp, 0)} marginal</p>
        {canEdit ? (
          <button
            type="button"
            onClick={() => {
              setValue(String(Math.round(targetBp / 100)));
              setError(undefined);
              setOpen(true);
            }}
            className="inline-flex min-h-11 items-center rounded-md border border-line-strong bg-surface px-4 text-base font-medium text-fg hover:bg-hover"
          >
            Ändra mål
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2">
      <label htmlFor={`${id}-mal`} className="label text-subtle">
        Mål för marginalen
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
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
            className="tnum h-12 w-28 rounded-md border border-line-control bg-bg pr-9 pl-3 text-right text-xl text-fg"
          />
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-base text-subtle">
            %
          </span>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-12 items-center rounded-md border border-inverse bg-inverse px-5 text-base font-medium text-on-inverse active:bg-inverse-hover disabled:border-dashed disabled:border-line-strong disabled:bg-transparent disabled:text-disabled"
        >
          {pending ? "Sparar…" : "Spara"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setOpen(false)}
          className="inline-flex h-12 items-center rounded-md border border-line-strong px-5 text-base text-fg hover:bg-hover"
        >
          Avbryt
        </button>
      </div>
      {error ? (
        <p id={`${id}-fel`} role="alert" className="text-sm text-signal-fg">
          {error}
        </p>
      ) : null}
    </form>
  );
}
