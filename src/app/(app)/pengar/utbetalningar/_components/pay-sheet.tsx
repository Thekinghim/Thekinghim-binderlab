"use client";

import { useState, useTransition, type ReactElement } from "react";

import { Button } from "@/components/v2/button";
import { Field, Input } from "@/components/v2/field";
import { Sheet, SheetClose } from "@/components/v2/sheet";
import { toastUndo, toastV2 } from "@/components/v2/toast";

import { krExact } from "../../_components/fmt";
import { oreToField, parseKr } from "../_lib/model";
import { markPaid, undoPaid } from "../actions";

/**
 * "Markera som betald" (eller "Markera som uttaget" för ägarens del): dagen (i dag som
 * standard) och beloppet (allt som är kvar, går att ändra för en delbetalning). Ångra i
 * notisen. Servern fördelar beloppet på raderna, äldsta utbetalningen först.
 */
export function PaySheet({
  name,
  lineIds,
  leftOre,
  today,
  trigger,
  verb = "betald",
  hint,
}: {
  name: string;
  lineIds: readonly string[];
  leftOre: number;
  today: string;
  trigger: ReactElement;
  verb?: "betald" | "uttaget" | "sparad";
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState(oreToField(leftOre));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const confirm = () => {
    const ore = parseKr(amount);
    if (ore === null || ore <= 0) {
      setError("Skriv ett belopp över 0 kr.");
      return;
    }
    if (ore > leftOre) {
      setError(`Det som är kvar är ${krExact(leftOre)}.`);
      return;
    }
    start(async () => {
      const res = await markPaid({ lineIds: [...lineIds], paidOn: date, amountOre: ore });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      // Åtgärden räknar om sidan i samma svar (revalidateSettlementData): ingen extra refresh.
      const refs = res.data.refs;
      toastUndo(
        `${krExact(res.data.paidOre)} till ${name} är markerat som ${verb}`,
        ore < leftOre ? `${krExact(leftOre - ore)} är kvar.` : undefined,
        () => {
          void undoPaid(refs).then((u) => {
            if (!u.ok) toastV2(u.error, { tone: "critical" });
          });
        },
      );
    });
  };

  const title =
    verb === "uttaget"
      ? "Markera som uttaget"
      : verb === "sparad"
        ? "Markera som sparad"
        : "Markera som betald";

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) {
          setDate(today);
          setAmount(oreToField(leftOre));
          setError(null);
        }
        setOpen(next);
      }}
      trigger={trigger}
      title={title}
      description={`${name} · ${krExact(leftOre)} kvar`}
      dismissible={!pending}
      footer={
        <>
          <SheetClose asChild>
            <Button size="lg" disabled={pending}>
              Avbryt
            </Button>
          </SheetClose>
          <Button
            size="lg"
            variant="act"
            pending={pending}
            onClick={confirm}
            data-testid="pay-confirm"
          >
            Klar
          </Button>
        </>
      }
    >
      <div className="ut-form">
        {hint ? <p className="ut-hint">{hint}</p> : null}
        <Field label="Dagen">
          {(p) => (
            <Input
              {...p}
              type="date"
              value={date}
              max={today}
              onChange={(e) => setDate(e.target.value)}
            />
          )}
        </Field>
        <Field label="Belopp" hint="Betalar du bara en del? Ändra beloppet.">
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              suffix="kr"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="pay-amount"
            />
          )}
        </Field>
        {error ? (
          <p role="alert" className="ut-err">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
