"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { dayRangeText, parseKrInput } from "@/server/settlements/advance";

import { exactKr } from "../_lib/settlement-headline";
import {
  deleteStorePayment,
  previewStorePayment,
  registerStorePayment,
} from "../settlement-actions";

interface PreviewPart {
  month: string;
  start: string;
  end: string;
  amountOre: number;
  effect: string;
}

/**
 * "Registrera betalning": en betalning till en butik för en egen period (t.ex. 14 okt.–
 * 14 nov.). Först visas hur den delas per månad (servern räknar), sedan sparas den. Inget
 * sparas på en uppdelning som ägaren inte har sett.
 */
export function RegisterPaymentButton({
  stores,
  today,
  defaultStoreId = null,
}: {
  stores: readonly { id: string; name: string }[];
  today: string;
  defaultStoreId?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [storeId, setStoreId] = useState(defaultStoreId ?? stores[0]?.id ?? "");
  const [paidOn, setPaidOn] = useState(today);
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPart[] | null>(null);
  const [pending, start] = useTransition();

  const input = () => {
    const amountOre = parseKrInput(amount);
    if (amountOre === null) return { error: "Skriv beloppet i kronor, t.ex. 10 089,32." };
    if (!from || !to) return { error: "Välj perioden betalningen gäller." };
    return {
      value: {
        storeId,
        paidOn,
        amountOre,
        periodStart: from,
        periodEnd: to,
        note: note.trim() ? note.trim() : null,
      },
    };
  };

  const showSplit = () => {
    const i = input();
    if ("error" in i) {
      setError(i.error ?? null);
      return;
    }
    start(async () => {
      const res = await previewStorePayment(i.value);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setPreview(res.data.parts);
    });
  };

  const save = () => {
    const i = input();
    if ("error" in i || !preview) return;
    start(async () => {
      const res = await registerStorePayment(
        i.value,
        preview.map((p) => p.amountOre),
      );
      if (!res.ok) {
        setError(res.error);
        setPreview(null);
        return;
      }
      setOpen(false);
      router.refresh();
      toast({
        title: `Klart! ${exactKr(i.value.amountOre)} till ${res.data.storeName} är registrerad.`,
        description:
          [res.data.settledText, res.data.closedText].filter(Boolean).join(" ") || undefined,
        tone: "ok",
      });
    });
  };

  const amountOre = parseKrInput(amount);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setError(null);
          setPreview(null);
          setPaidOn(today);
          setOpen(true);
        }}
      >
        Registrera betalning
      </Button>
      <Modal
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        dismissible={!pending}
        eyebrow="Betalning till butik"
        title={preview ? "Så delas betalningen" : "Registrera betalning"}
        description={
          preview
            ? `${amountOre !== null ? exactKr(amountOre) : ""} för ${dayRangeText({ start: from, end: to }).replace(/\.$/, "")}. Det som gäller en månad dras av på den månadens avräkning.`
            : "Det du har betalat till butiken och vilka dagar det gällde."
        }
        size="sm"
        footer={
          preview ? (
            <>
              <Button variant="secondary" onClick={() => setPreview(null)} disabled={pending}>
                Ändra
              </Button>
              <Button variant="primary" loading={pending} onClick={save}>
                Registrera
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
                Avbryt
              </Button>
              <Button variant="primary" loading={pending} onClick={showSplit}>
                Fortsätt
              </Button>
            </>
          )
        }
      >
        {preview ? (
          <div className="flex flex-col gap-3" data-payment-preview>
            <ul className="flex flex-col border-t border-line">
              {preview.map((p) => (
                <li
                  key={p.month}
                  className="flex items-start justify-between gap-4 border-b border-line py-2"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-base text-fg">{dayRangeText(p)}</span>
                    <span className="text-sm text-muted">{p.effect}</span>
                  </span>
                  <span className="tnum shrink-0 text-base text-fg">{exactKr(p.amountOre)}</span>
                </li>
              ))}
            </ul>
            {error ? (
              <p role="alert" className="text-sm text-signal-fg">
                {error}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-4" data-payment-form>
            <Select
              label="Butik"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              options={stores.map((s) => ({ value: s.id, label: s.name }))}
              wrapperClassName="w-full"
            />
            <Input
              label="Belopp"
              inputMode="decimal"
              autoComplete="off"
              placeholder="10 089,32"
              suffix="kr"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              wrapperClassName="w-full"
            />
            <Input
              label="Betald den"
              type="date"
              value={paidOn}
              max={today}
              onChange={(e) => setPaidOn(e.target.value)}
              wrapperClassName="w-full"
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Gäller från"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                wrapperClassName="w-full"
              />
              <Input
                label="Till och med"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                wrapperClassName="w-full"
              />
            </div>
            <Input
              label="Anteckning (valfri)"
              autoComplete="off"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              error={error ?? undefined}
              wrapperClassName="w-full"
            />
          </div>
        )}
      </Modal>
    </>
  );
}

/** "Ta bort" en felaktig betalning. Frågar först. */
export function DeletePaymentButton({
  id,
  storeName,
  amountOre,
  periodLabel,
  blocked,
}: {
  id: string;
  storeName: string;
  amountOre: number;
  /** "14 okt.–14 nov." */
  periodLabel: string;
  /** Varför den inte kan tas bort nu (stängd månad), annars null. */
  blocked: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const confirm = () =>
    start(async () => {
      const res = await deleteStorePayment(id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
      toast({
        title: "Betalningen är borttagen.",
        description: res.data.reopenedText ?? undefined,
        tone: "ok",
      });
    });
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Ta bort betalningen till ${storeName} för ${periodLabel}`}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Ta bort
      </Button>
      <Modal
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        dismissible={!pending}
        eyebrow="Betalning till butik"
        title={`Ta bort ${exactKr(amountOre)} till ${storeName}?`}
        description={`Betalningen för ${periodLabel} försvinner. Avräkningar som var betalda med den blir obetalda igen.`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Avbryt
            </Button>
            <Button
              variant="danger"
              loading={pending}
              disabled={blocked !== null}
              onClick={confirm}
            >
              Ja, ta bort
            </Button>
          </>
        }
      >
        {blocked || error ? (
          <p role="alert" className="text-sm text-signal-fg">
            {error ?? blocked}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
