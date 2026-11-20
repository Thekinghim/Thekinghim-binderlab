"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { inviteStoreUser } from "@/server/portal/actions";

import { exactKr, noAgreementLine } from "../_lib/settlement-headline";
import {
  carrySettlementDifference,
  createMissingSettlements,
  markSettlementPaid,
  removeSettlementCorrection,
  recomputeSettlement,
  undoSettlementPaid,
} from "../settlement-actions";

// Betalningar och rättelser med öre: ett avrundat belopp kan få två val att se lika ut.
const kr = exactKr;

/**
 * "Markera som betald" med datum (i dag förvalt) och "Ångra" i toasten. Server actions
 * kontrollerar rollen; databasen sätter vem och när och låser beloppet.
 *
 * Säger rapporten butiken fick ett annat belopp (`reportOre`) frågar dialogen vilket
 * belopp som betalades. Inget är förvalt: ägaren väljer.
 */
export function MarkPaidButton({
  id,
  storeName,
  amountOre,
  advanceOre = 0,
  reportOre = null,
  monthLabel,
  today,
}: {
  id: string;
  storeName: string;
  amountOre: number;
  /** Redan betalt i förskott för månaden (betalningar för en egen period). */
  advanceOre?: number;
  /** Beloppet i den godkända rapporten för samma månad (med avräkningens rättelser), eller null. */
  reportOre?: number | null;
  monthLabel: string;
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ reportOre: number; liveOre: number } | null>(
    reportOre !== null && reportOre !== amountOre ? { reportOre, liveOre: amountOre } : null,
  );
  const [choice, setChoice] = useState<"live" | "report" | null>(null);
  const [pending, start] = useTransition();

  const confirm = () =>
    start(async () => {
      const res = await markSettlementPaid(id, date, amountOre, choice);
      if (!res.ok) {
        if ("ask" in res) {
          // Servern såg en rapport med annat belopp: fråga innan något betalas.
          setAsk(res.ask);
          setChoice(null);
          setError(null);
          return;
        }
        setError(res.error);
        // Beloppet kan ha ändrats: visa det nya under dialogen.
        router.refresh();
        return;
      }
      setOpen(false);
      router.refresh();
      const paidOre = res.data.paidOre;
      const meta = [
        res.data.differenceOre !== 0
          ? `Skillnaden ${kr(Math.abs(res.data.differenceOre))} står kvar på Utbetalning.`
          : null,
        res.data.closedText,
      ]
        .filter(Boolean)
        .join(" ");
      toast({
        title:
          paidOre < 0
            ? `Klart! ${kr(-paidOre)} från ${storeName} är betald.`
            : `Klart! ${kr(paidOre - advanceOre)} till ${storeName} är betald.`,
        description: meta || undefined,
        tone: "ok",
        action: {
          label: "Ångra",
          onClick: () => {
            void undoSettlementPaid(id).then((undo) => {
              router.refresh();
              if (undo.ok && undo.data.periodText) toast({ title: undo.data.periodText });
              if (!undo.ok) toast({ title: undo.error, tone: "critical" });
            });
          },
        },
      });
    });

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        onClick={() => {
          setError(null);
          setDate(today);
          setChoice(null);
          setOpen(true);
        }}
      >
        Markera som betald
      </Button>
      <Modal
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        eyebrow="Avräkning"
        title={
          amountOre < 0
            ? `${kr(-amountOre)} från ${storeName}`
            : `${kr(amountOre - advanceOre)} till ${storeName}`
        }
        description={
          advanceOre > 0 && amountOre > 0
            ? `${monthLabel}. Avräkningen ${kr(amountOre)}, redan betalt i förskott ${kr(advanceOre)}. Kvar att betala ${kr(amountOre - advanceOre)}.`
            : monthLabel
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Avbryt
            </Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={ask !== null && choice === null}
              onClick={confirm}
            >
              Betald
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {ask ? (
            <fieldset className="flex flex-col gap-2" data-paid-which>
              <legend className="pb-2 text-base text-fg">
                Rapporten butiken fick säger {kr(ask.reportOre)}. Dagens uträkning säger{" "}
                {kr(ask.liveOre)}. Vilket belopp har du betalat?
              </legend>
              {(
                [
                  ["live", `${kr(ask.liveOre)} (dagens uträkning)`],
                  ["report", `${kr(ask.reportOre)} (rapporten)`],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex min-h-11 items-center gap-3 text-base text-fg">
                  <input
                    type="radio"
                    name={`paid-which-${id}`}
                    value={value}
                    checked={choice === value}
                    onChange={() => setChoice(value)}
                  />
                  {label}
                </label>
              ))}
              {choice === "report" ? (
                <p className="text-sm text-muted">
                  Skillnaden {kr(Math.abs(ask.liveOre - ask.reportOre))} visas på Utbetalning. Du
                  kan lägga den på nästa avräkning.
                </p>
              ) : null}
            </fieldset>
          ) : null}
          <Input
            label="Betald den"
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            error={error ?? undefined}
            wrapperClassName="w-full"
          />
        </div>
      </Modal>
    </>
  );
}

/**
 * "Lägg på nästa avräkning": skillnaden på en betald avräkning blir en egen rad på butikens
 * nästa obetalda. Frågar först, så att inget läggs till av misstag.
 */
export function CarryDifferenceButton({
  id,
  storeName,
  differenceOre,
  monthLabel,
  targetMonthLabel,
}: {
  id: string;
  storeName: string;
  differenceOre: number;
  /** Månaden som rättas, "oktober 2026". */
  monthLabel: string;
  /** Månaden skillnaden läggs på, "november 2026". */
  targetMonthLabel: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const amount = kr(Math.abs(differenceOre));
  const confirm = () =>
    start(async () => {
      const res = await carrySettlementDifference(id, differenceOre);
      if (!res.ok) {
        setError(res.error);
        router.refresh();
        return;
      }
      setOpen(false);
      router.refresh();
      toast({
        title: `Klart! ${amount} ligger på avräkningen för ${res.data.targetMonth}.`,
        meta: storeName,
        tone: "ok",
      });
    });
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Lägg på nästa avräkning
      </Button>
      <Modal
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        eyebrow="Rättelse"
        title={
          differenceOre > 0
            ? `Lägg till ${amount} på avräkningen för ${targetMonthLabel}?`
            : `Dra av ${amount} på avräkningen för ${targetMonthLabel}?`
        }
        description={`Det blir en egen rad: Rättelse för ${monthLabel}. ${storeName} ser raden. Det som redan är betalt ändras inte.`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Avbryt
            </Button>
            <Button variant="primary" loading={pending} onClick={confirm}>
              {differenceOre > 0 ? "Ja, lägg till" : "Ja, dra av"}
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
    </>
  );
}

/** "Ta bort" en rättelse på en obetald avräkning. */
export function RemoveCorrectionButton({
  targetId,
  sourceId,
  label,
}: {
  targetId: string;
  sourceId: string;
  /** "Rättelse för oktober 2026" */
  label: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      aria-label={`Ta bort ${label}`}
      onClick={() =>
        start(async () => {
          const res = await removeSettlementCorrection(targetId, sourceId);
          if (!res.ok) toast({ title: res.error, tone: "critical" });
          else toast({ title: "Rättelsen är borttagen.", tone: "ok" });
          router.refresh();
        })
      }
    >
      Ta bort
    </Button>
  );
}

/** Ångra "betald" (låg vikt, i raden). */
export function UndoPaidButton({ id, storeName }: { id: string; storeName: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      aria-label={`Ångra betald för ${storeName}`}
      onClick={() =>
        start(async () => {
          const res = await undoSettlementPaid(id);
          if (!res.ok) toast({ title: res.error, tone: "critical" });
          else if (res.data.periodText) toast({ title: res.data.periodText });
          router.refresh();
        })
      }
    >
      Ångra
    </Button>
  );
}

/**
 * Skapa förra månadens saknade avräkningar (sidan skapar inget av sig själv). Saknar en
 * butik avtal frågar knappen först: "Lägg in avtal först, eller skapa ändå" (servern skapar
 * inget utan bekräftelsen).
 */
export function CreateSettlementsButton({
  count,
  monthLabel,
}: {
  count: number;
  /** "november", eller null när avräkningar saknas för flera månader. */
  monthLabel: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [ask, setAsk] = useState<{ storeName: string; days: number; whole: boolean }[] | null>(
    null,
  );
  const run = (confirm: boolean) =>
    start(async () => {
      const res = await createMissingSettlements(confirm);
      if (!res.ok) {
        toast({ title: res.error, tone: "critical" });
        return;
      }
      if (res.data.noAgreement && res.data.noAgreement.length > 0) {
        setAsk(res.data.noAgreement);
        return;
      }
      setAsk(null);
      router.refresh();
      toast({
        title:
          res.data.created > 0
            ? `Klart! ${res.data.created === 1 ? "1 avräkning" : `${res.data.created} avräkningar`} skapade.`
            : "Inget nytt att skapa.",
        tone: res.data.errors > 0 ? "critical" : "ok",
      });
    });
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        loading={pending && ask === null}
        onClick={() => run(false)}
      >
        {monthLabel
          ? `Skapa ${monthLabel}-avräkning${count === 1 ? "en" : "arna"}`
          : `Skapa avräkning${count === 1 ? "en" : "arna"}`}
      </Button>
      <Modal
        open={ask !== null}
        onClose={() => (pending ? undefined : setAsk(null))}
        eyebrow="Utbetalning"
        title={
          ask && ask.length === 1
            ? `${ask[0]!.storeName} har inget avtal.`
            : `${ask?.length ?? 0} butiker saknar avtal.`
        }
        description="Utan avtal räknas butiken som 0 %. Lägg in avtalet först, så blir beloppet rätt."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAsk(null)} disabled={pending}>
              Avbryt
            </Button>
            <Button variant="danger" loading={pending} onClick={() => run(true)}>
              Skapa ändå
            </Button>
          </>
        }
      >
        <ul className="flex flex-col gap-1 text-base text-fg" data-no-agreement-confirm>
          {(ask ?? []).map((g) => (
            <li key={g.storeName}>{noAgreementLine(g)}</li>
          ))}
        </ul>
      </Modal>
    </>
  );
}

/** Spara det nya beloppet på en obetald avräkning (det butiken ser i portalen). */
export function RecomputeButton({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      onClick={() =>
        start(async () => {
          const res = await recomputeSettlement(id);
          if (!res.ok) {
            toast({ title: res.error, tone: "critical" });
            return;
          }
          router.refresh();
          toast({
            title:
              res.data.amountOre === res.data.previousOre
                ? "Samma belopp."
                : `Nytt belopp: ${kr(res.data.amountOre)}`,
            tone: "ok",
          });
        })
      }
    >
      Räkna om
    </Button>
  );
}

/**
 * Bjud in butiken till portalen med en knapp. Med butikens e-post skickas inbjudan direkt
 * (magisk länk i mejlet); utan e-post frågar dialogen efter den.
 */
export function InviteStoreButton({
  storeId,
  storeName,
  email,
  again,
}: {
  storeId: string;
  storeName: string;
  email: string | null;
  again?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(email ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const send = (to: string) =>
    start(async () => {
      const res = await inviteStoreUser({ storeId, email: to });
      if (!res.ok) {
        setError(res.error);
        setOpen(true);
        return;
      }
      setOpen(false);
      router.refresh();
      toast({ title: `Inbjudan skickad till ${to}`, tone: "ok", meta: storeName });
    });

  return (
    <>
      <Button
        variant={again ? "ghost" : "secondary"}
        size="sm"
        loading={pending && !open}
        onClick={() => {
          setError(null);
          if (email && !again) send(email);
          else setOpen(true);
        }}
      >
        {again ? "Skicka igen" : "Bjud in"}
      </Button>
      <Modal
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        eyebrow="Butiksportal"
        title={`Bjud in ${storeName}`}
        description="De får en länk i mejlet och ser bara sin butik."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Avbryt
            </Button>
            <Button variant="primary" loading={pending} onClick={() => send(value.trim())}>
              Skicka
            </Button>
          </>
        }
      >
        <Input
          label="E-post"
          type="email"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={error ?? undefined}
          wrapperClassName="w-full"
        />
      </Modal>
    </>
  );
}
