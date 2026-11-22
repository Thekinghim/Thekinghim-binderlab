"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactElement } from "react";

import { Button } from "@/components/v2/button";
import { Sheet, SheetClose } from "@/components/v2/sheet";
import { toastUndo, toastV2 } from "@/components/v2/toast";

import { krExact, dayMonth, monthName } from "../../../pengar/_components/fmt";
import { markSettlementPaid, undoSettlementPaid } from "../../settlement-actions";

export interface PaySheetItem {
  readonly id: string;
  readonly storeName: string;
  readonly month: string;
  readonly amountOre: number;
  readonly advanceOre: number;
  readonly leftOre: number;
  readonly reportOre: number | null;
  readonly due: string;
}

/**
 * "Betala" i V2: samma flöde som Utbetalningens "Markera som betald" (markSettlementPaid med
 * beloppet ägaren såg, rapportfrågan, förskott som täcker allt) i ett ark, och "Ångra" i
 * notisen (undoSettlementPaid). Servern kontrollerar rollen och låser beloppet.
 */
export function PaySheet({
  item,
  today,
  trigger,
}: {
  item: PaySheetItem;
  today: string;
  trigger: ReactElement;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const covered = item.advanceOre > 0 && item.amountOre - item.advanceOre <= 0;
  const initialAsk =
    !covered && item.reportOre !== null && item.reportOre !== item.amountOre
      ? { reportOre: item.reportOre, liveOre: item.amountOre }
      : null;
  const [ask, setAsk] = useState(initialAsk);
  const [choice, setChoice] = useState<"live" | "report" | null>(null);
  const [pending, start] = useTransition();

  const confirm = () =>
    start(async () => {
      const res = await markSettlementPaid(item.id, date, item.amountOre, choice);
      if (!res.ok) {
        if ("ask" in res) {
          setAsk(res.ask);
          setChoice(null);
          setError(null);
          return;
        }
        setError(res.error);
        router.refresh();
        return;
      }
      setOpen(false);
      router.refresh();
      if (res.data.paidFromPayments) {
        toastV2(`Avräkningen för ${item.storeName} är betald med betalningarna.`, {
          detail: res.data.closedText ?? undefined,
        });
        return;
      }
      const paid = res.data.paidOre;
      const detail = [
        res.data.differenceOre !== 0
          ? `Skillnaden ${krExact(Math.abs(res.data.differenceOre))} står kvar på Utbetalning.`
          : null,
        res.data.closedText,
      ]
        .filter(Boolean)
        .join(" ");
      toastUndo(
        paid < 0
          ? `${krExact(-paid)} från ${item.storeName} är betald`
          : `${krExact(paid - item.advanceOre)} till ${item.storeName} är betald`,
        detail || `Butikens andel för ${monthName(item.month)}`,
        () => {
          void undoSettlementPaid(item.id).then((undo) => {
            router.refresh();
            if (!undo.ok) toastV2(undo.error, { tone: "critical" });
            else if (undo.data.periodText) toastV2(undo.data.periodText, { tone: "neutral" });
          });
        },
      );
    });

  const title = covered
    ? `${item.storeName} har redan fått betalt`
    : item.amountOre < 0
      ? `${krExact(-item.amountOre)} från ${item.storeName}`
      : `${krExact(item.leftOre)} till ${item.storeName}`;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) {
          setDate(today);
          setError(null);
          setChoice(null);
          setAsk(initialAsk);
        }
        setOpen(next);
      }}
      trigger={trigger}
      title={title}
      description={`Butikens andel för ${monthName(item.month)} · betala senast ${dayMonth(item.due)}`}
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
            disabled={ask !== null && choice === null}
            onClick={confirm}
          >
            Markera som betald
          </Button>
        </>
      }
    >
      <div className="g4-form">
        <div className="g4-split">
          <div className="cr">
            <span>Avräkningen</span>
            <b>{krExact(item.amountOre)}</b>
          </div>
          {item.advanceOre > 0 ? (
            <div className="cr">
              <span>Redan betalt i förskott</span>
              <b>−{krExact(item.advanceOre)}</b>
            </div>
          ) : null}
          <div className="cr">
            <span>Kvar att betala</span>
            <b>{krExact(Math.max(0, item.leftOre))}</b>
          </div>
        </div>
        {ask ? (
          <fieldset className="g4-form" data-paid-which>
            <legend className="g4-field" style={{ color: "var(--v2-ink)", marginBottom: 6 }}>
              Rapporten butiken fick säger {krExact(ask.reportOre)}. Dagens uträkning säger{" "}
              {krExact(ask.liveOre)}. Vilket belopp har du betalat?
            </legend>
            {(
              [
                ["live", `${krExact(ask.liveOre)} (dagens uträkning)`],
                ["report", `${krExact(ask.reportOre)} (rapporten)`],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-11 items-center gap-3">
                <input
                  type="radio"
                  name={`paid-which-${item.id}`}
                  value={value}
                  checked={choice === value}
                  onChange={() => setChoice(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
        ) : null}
        {covered ? (
          <p className="g4-field">Avräkningen markeras som betald med betalningarna.</p>
        ) : (
          <label className="g4-field">
            Betald den
            <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </label>
        )}
        {error ? (
          <p role="alert" className="g4-err">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
