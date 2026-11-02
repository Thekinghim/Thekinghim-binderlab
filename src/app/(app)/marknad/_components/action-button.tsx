"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import type { ActionResult } from "../_lib/types";

type Props<T> = {
  /** Server action som tar indata och svarar med ActionResult. */
  action: (raw: unknown) => Promise<ActionResult<T>>;
  payload: unknown;
  children: ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  iconLeft?: ButtonProps["iconLeft"];
  /** Kvitto efter lyckad åtgärd. */
  success: string;
  /** Bekräftelse före åtgärden (dialog). */
  confirm?: {
    title: string;
    description: string;
    confirmLabel: string;
    eyebrow?: string;
    danger?: boolean;
  };
  className?: string;
};

/**
 * Knapp som kör en server action, med valfri bekräftelse, laddningsläge och notis.
 * Fel visas som notis med felet i klartext; sidan räknas om efter en lyckad åtgärd.
 */
export function ActionButton<T>({
  action,
  payload,
  children,
  variant = "secondary",
  size = "sm",
  iconLeft,
  success,
  confirm,
  className,
}: Props<T>) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await action(payload);
      if (!result.ok) {
        if (confirm) setError(result.error);
        else toast({ title: "Inget ändrades", description: result.error, tone: "critical" });
        return;
      }
      setOpen(false);
      toast({
        title: success,
        tone: "ok",
      });
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        iconLeft={iconLeft}
        loading={pending && !confirm}
        onClick={() => (confirm ? setOpen(true) : run())}
        className={className}
      >
        {children}
      </Button>
      {confirm ? (
        <Modal
          open={open}
          onClose={() => (pending ? undefined : setOpen(false))}
          title={confirm.title}
          eyebrow={confirm.eyebrow}
          description={confirm.description}
          size="sm"
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Avbryt
              </Button>
              <Button
                type="button"
                variant={confirm.danger ? "danger-confirm" : "primary"}
                loading={pending}
                onClick={run}
              >
                {confirm.confirmLabel}
              </Button>
            </>
          }
        >
          {error ? (
            <p role="alert" className="text-sm text-signal-fg">
              {error}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}
