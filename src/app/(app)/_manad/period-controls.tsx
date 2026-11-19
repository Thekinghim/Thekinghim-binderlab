"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { closeMonth, reopenMonth } from "./actions";

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * "Öppna månaden igen" (bara ägaren). Frågar efter en anledning, som sparas och loggas.
 * `monthLabel` är "oktober 2026".
 */
export function ReopenMonthButton({ month, monthLabel }: { month: string; monthLabel: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const confirm = () =>
    start(async () => {
      const res = await reopenMonth(month, reason);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
      toast({
        title: `${cap(monthLabel)} är öppen igen.`,
        meta: "Stäng månaden när du har rättat.",
        tone: "ok",
      });
    });

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Öppna månaden igen
      </Button>
      <Modal
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        eyebrow="Stängd månad"
        title={`Öppna ${monthLabel} igen?`}
        description="Då kan priser, avtal, testköp och återbetalningar ändras i månaden. Betalda avräkningar ändras inte. Skillnaden visas på Utbetalning."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Avbryt
            </Button>
            <Button variant="danger" loading={pending} onClick={confirm}>
              Öppna månaden
            </Button>
          </>
        }
      >
        <Input
          label="Varför?"
          value={reason}
          maxLength={500}
          placeholder="Till exempel: fel inköpspris"
          onChange={(e) => setReason(e.target.value)}
          error={error ?? undefined}
          wrapperClassName="w-full"
        />
      </Modal>
    </>
  );
}

/** "Stäng månaden" (ägare och admin) för en månad som öppnats igen. */
export function CloseMonthButton({ month, monthLabel }: { month: string; monthLabel: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={() =>
        start(async () => {
          const res = await closeMonth(month);
          if (!res.ok) {
            toast({ title: res.error, tone: "critical" });
            return;
          }
          router.refresh();
          toast({ title: `Klart! ${cap(monthLabel)} är stängd.`, tone: "ok" });
        })
      }
    >
      Stäng månaden
    </Button>
  );
}
