"use client";

import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

export type Result = { ok: true } | { ok: false; error: string };

/** Läser ett textfält ur formuläret ("" om det saknas). */
export function text(data: FormData, key: string): string {
  const v = data.get(key);
  return typeof v === "string" ? v : "";
}

/**
 * Formulär i en dialog: Enter skickar, fel visas i dialogen (signal på glyfen, text i fg),
 * kvittot visas av anroparen som notis. Fälten monteras bara när dialogen är öppen, så
 * att standardvärdena alltid är färska.
 */
export function FormDialog({
  open,
  onClose,
  title,
  eyebrow,
  description,
  submitLabel,
  onSubmit,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow: string;
  description?: string;
  submitLabel: string;
  onSubmit: (data: FormData) => Promise<Result>;
  children: ReactNode;
}) {
  const formId = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await onSubmit(data);
      if (!result.ok) setError(result.error);
    });
  };

  const close = () => {
    if (pending) return;
    setError(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      eyebrow={eyebrow}
      description={description}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            Avbryt
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={pending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {open ? (
        <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {children}
          {error ? (
            <p role="alert" className="flex items-start gap-2 text-sm">
              <span aria-hidden className="mt-1.5 inline-block size-2 shrink-0 bg-signal" />
              <span className="text-fg">
                <span className="sr-only">Kräver åtgärd: </span>
                {error}
              </span>
            </p>
          ) : null}
        </form>
      ) : null}
    </Modal>
  );
}
