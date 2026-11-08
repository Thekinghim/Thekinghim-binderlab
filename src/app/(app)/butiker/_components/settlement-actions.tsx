"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { formatSek } from "@/lib/format";
import { inviteStoreUser } from "@/server/portal/actions";

import { noAgreementLine } from "../_lib/settlement-headline";
import {
  createMissingSettlements,
  markSettlementPaid,
  recomputeSettlement,
  undoSettlementPaid,
} from "../settlement-actions";

const kr = (ore: number) => formatSek(ore / 100);

/**
 * "Markera som betald" med datum (i dag förvalt) och "Ångra" i toasten. Server actions
 * kontrollerar rollen; databasen sätter vem och när och låser beloppet.
 */
export function MarkPaidButton({
  id,
  storeName,
  amountOre,
  monthLabel,
  today,
}: {
  id: string;
  storeName: string;
  amountOre: number;
  monthLabel: string;
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const confirm = () =>
    start(async () => {
      const res = await markSettlementPaid(id, date, amountOre);
      if (!res.ok) {
        setError(res.error);
        // Beloppet kan ha ändrats: visa det nya under dialogen.
        router.refresh();
        return;
      }
      setOpen(false);
      router.refresh();
      toast({
        title:
          amountOre < 0
            ? `Klart! ${kr(-amountOre)} från ${storeName} är betald.`
            : `Klart! ${kr(amountOre)} till ${storeName} är betald.`,
        tone: "ok",
        action: {
          label: "Ångra",
          onClick: () => {
            void undoSettlementPaid(id).then(() => router.refresh());
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
            : `${kr(amountOre)} till ${storeName}`
        }
        description={monthLabel}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Avbryt
            </Button>
            <Button variant="primary" loading={pending} onClick={confirm}>
              Betald
            </Button>
          </>
        }
      >
        <Input
          label="Betald den"
          type="date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
          error={error ?? undefined}
          wrapperClassName="w-full"
        />
      </Modal>
    </>
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
  /** "november" */
  monthLabel: string;
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
        {`Skapa ${monthLabel}-avräkning${count === 1 ? "en" : "arna"}`}
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
