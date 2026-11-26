"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";

import { cardFeeConfirm, cardFeeDone } from "../../installningar/_lib/model";
import { applyStatementCardFee } from "../actions";
import { cardFeeHelp } from "../_lib/nayax";
import { FormError } from "./bits";

/**
 * "Nayax tar 4,0 % i kortavgift. Appen räknar med 0 %." med knappen "Ändra till 4,0 %".
 * Visas bara när rapportens kortavgift skiljer sig från inställningen. Knappen frågar först:
 * från vilken dag satsen gäller (förvalt första dagen som inte är låst) och att stängda
 * månader inte ändras. Satsen räknas på servern ur den sparade rapporten.
 */
export function CardFeeFix({
  payoutId,
  statementBp,
  settingBp,
  defaultFrom,
  today,
}: {
  payoutId: string;
  statementBp: number | null;
  settingBp: number;
  /** Första dagen som inte är låst (ÅÅÅÅ-MM-DD). null = inget är låst: all försäljning. */
  defaultFrom: string | null;
  today: string;
}) {
  const router = useRouter();
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(defaultFrom ?? "");
  const [pending, startTransition] = useTransition();
  const help = cardFeeHelp(statementBp, settingBp);
  if (done) {
    return (
      <p role="status" className="text-sm text-fg">
        {done}
      </p>
    );
  }
  if (!help || statementBp === null) return null;
  const chosen = from === "" ? null : from;
  const confirm = cardFeeConfirm(statementBp, settingBp, chosen);
  const apply = () => {
    setError(undefined);
    startTransition(async () => {
      const res = await applyStatementCardFee({ payoutId, from: chosen }).catch(() => ({
        ok: false as const,
        error: "Ingen kontakt med servern. Försök igen.",
      }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setDone(cardFeeDone(statementBp, res.data.from));
      router.refresh();
    });
  };
  return (
    <div data-card-fee-fix className="flex flex-col gap-2">
      <p className="text-sm text-fg">{help.text}</p>
      <Button
        type="button"
        variant="secondary"
        className="min-h-11 self-start"
        onClick={() => {
          setError(undefined);
          setOpen(true);
        }}
      >
        {help.button}
      </Button>
      <Modal
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        dismissible={!pending}
        eyebrow="Kortavgift"
        title={confirm.title}
        description={confirm.text}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Avbryt
            </Button>
            <Button variant="primary" loading={pending} onClick={apply}>
              {confirm.button}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Gäller från"
            type="date"
            max={today}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            hint="Tomt = all försäljning."
            wrapperClassName="w-full"
          />
          <FormError message={error} />
        </div>
      </Modal>
    </div>
  );
}
