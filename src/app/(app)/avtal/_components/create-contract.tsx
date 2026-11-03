"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { DialogButtons, FormError } from "../../ekonomi/_components/bits";
import { createContract } from "../actions";

/**
 * Skapa avtal: butik och startdag, ett klick. Avtalet (PDF), villkoren 50/50 av vinsten
 * efter kostnader och statusen Utkast skapas på servern. Efteråt öppnas Avtal vid avtalet.
 */
export function CreateContract({
  options,
  today,
  initialTarget,
  autoOpen = false,
  orgNumberMissing,
  firstContract = false,
  variant = "primary",
}: {
  /** `suggestedFrom`: startdagen som skriver om butikens felaktiga villkor (andel av försäljningen). */
  options: { value: string; label: string; suggestedFrom?: string | null }[];
  today: string;
  /** Förvald butik ("store:{id}" eller "lead:{id}"). */
  initialTarget?: string;
  autoOpen?: boolean;
  orgNumberMissing: boolean;
  /** Inget avtal från mallen finns ännu: påminn en gång om att låta någon läsa mallen. */
  firstContract?: boolean;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const toast = useToast();
  const first = initialTarget && options.some((o) => o.value === initialTarget);
  const [open, setOpen] = useState(autoOpen && Boolean(first));
  const startOf = (value: string) => options.find((o) => o.value === value)?.suggestedFrom ?? today;
  const [target, setTarget] = useState(first ? initialTarget! : (options[0]?.value ?? ""));
  const [validFrom, setValidFrom] = useState(() => startOf(target));
  const [confirm, setConfirm] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setConfirm(undefined);
    setError(undefined);
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!target) return setError("Välj en butik.");
    if (!validFrom) return setError("Ange startdag.");
    setError(undefined);
    startTransition(async () => {
      const res = await createContract({ target, validFrom, confirmHistory: Boolean(confirm) });
      if (!res.ok) {
        if (res.needsConfirm) setConfirm(res.error);
        else setError(res.error);
        return;
      }
      toast({
        title: "Avtalet skapat",
        description: res.data.pdf
          ? `${res.data.storeName}. Villkoren gäller i rapporten.`
          : `${res.data.storeName}. PDF kunde inte skapas här; skriv ut från avtalet.`,
        tone: "ok",
      });
      setOpen(false);
      router.push(`/avtal#avtal-${res.data.id}`);
      router.refresh();
    });
  };

  if (options.length === 0) return null;

  return (
    <>
      <Button
        variant={variant}
        iconLeft="plus"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        Skapa avtal
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Avtal"
        title="Skapa avtal"
        description="50/50 av vinsten efter kostnader · tills vidare · 1 mån uppsägning"
        size="sm"
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <Select
            label="Butik"
            value={target}
            options={options}
            onChange={(e) => {
              setTarget(e.target.value);
              setValidFrom(startOf(e.target.value));
              reset();
            }}
          />
          <Input
            label="Gäller från"
            type="date"
            value={validFrom}
            onChange={(e) => {
              setValidFrom(e.target.value);
              reset();
            }}
          />
          {orgNumberMissing ? (
            <p className="meta text-subtle">
              <Link href="/ekonomi?vy=bokforing#bokforing" className="underline underline-offset-2">
                Lägg in organisationsnumret
              </Link>{" "}
              så står det på avtalet.
            </p>
          ) : null}
          {firstContract ? (
            <p className="meta text-subtle">Mall: låt Talenom läsa den en gång.</p>
          ) : null}
          {confirm ? (
            <p role="status" className="meta text-fg">
              {confirm}
            </p>
          ) : null}
          <FormError message={error} />
          <DialogButtons>
            <Button type="button" onClick={() => setOpen(false)}>
              Avbryt
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              {confirm ? "Skapa ändå" : "Skapa avtal"}
            </Button>
          </DialogButtons>
        </form>
      </Modal>
    </>
  );
}
