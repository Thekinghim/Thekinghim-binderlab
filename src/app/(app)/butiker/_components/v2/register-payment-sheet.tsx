"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/v2/button";
import { Sheet } from "@/components/v2/sheet";
import { toastV2 } from "@/components/v2/toast";
import { dayRangeText, parseKrInput } from "@/server/settlements/advance";

import { krExact } from "../../../pengar/_components/fmt";
import { previewStorePayment, registerStorePayment } from "../../settlement-actions";

interface PreviewPart {
  month: string;
  start: string;
  end: string;
  amountOre: number;
  effect: string;
}

/**
 * "Registrera betalning" i V2 (förskott eller betalning för en egen period): samma två steg
 * som Utbetalning. Först visar servern hur betalningen delas per månad (previewStorePayment,
 * src/server/settlements/advance.ts), sedan sparas den bara med den uppdelningen
 * (registerStorePayment). Inget sparas på en uppdelning som ägaren inte har sett.
 */
export function RegisterPaymentSheet({
  stores,
  today,
  defaultStoreId = null,
  label = "Registrera betalning",
}: {
  stores: readonly { id: string; name: string }[];
  today: string;
  defaultStoreId?: string | null;
  label?: string;
}) {
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
      toastV2(`${krExact(i.value.amountOre)} till ${res.data.storeName} är registrerad`, {
        detail:
          [res.data.settledText, res.data.closedText].filter(Boolean).join(" ") ||
          "Det dras av på avräkningen för samma dagar.",
      });
    });
  };

  const amountOre = parseKrInput(amount);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) {
          setError(null);
          setPreview(null);
          setPaidOn(today);
          if (defaultStoreId) setStoreId(defaultStoreId);
        }
        setOpen(next);
      }}
      dismissible={!pending}
      trigger={
        <Button variant="act" size="md">
          {label}
        </Button>
      }
      title={preview ? "Så delas betalningen" : "Registrera betalning"}
      description={
        preview
          ? `${amountOre !== null ? krExact(amountOre) : ""} för ${dayRangeText({ start: from, end: to }).replace(/\.$/, "")}. Det som gäller en månad dras av på den månadens avräkning.`
          : "Det du har betalat till butiken och vilka dagar det gällde."
      }
      footer={
        preview ? (
          <>
            <Button size="lg" onClick={() => setPreview(null)} disabled={pending}>
              Ändra
            </Button>
            <Button size="lg" variant="act" pending={pending} onClick={save}>
              Registrera
            </Button>
          </>
        ) : (
          <>
            <Button size="lg" onClick={() => setOpen(false)} disabled={pending}>
              Avbryt
            </Button>
            <Button size="lg" variant="act" pending={pending} onClick={showSplit}>
              Fortsätt
            </Button>
          </>
        )
      }
    >
      {preview ? (
        <div className="g4-form" data-payment-preview>
          <div className="g4-split">
            {preview.map((p) => (
              <div key={p.month} className="cr">
                <span>
                  {dayRangeText(p)}
                  <small>{p.effect}</small>
                </span>
                <b>{krExact(p.amountOre)}</b>
              </div>
            ))}
          </div>
          {error ? (
            <p role="alert" className="g4-err">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="g4-form" data-payment-form>
          <label className="g4-field">
            Butik
            <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="g4-field">
            Belopp (kr)
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="10 089,32"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="g4-field">
            Betald den
            <input
              type="date"
              value={paidOn}
              max={today}
              onChange={(e) => setPaidOn(e.target.value)}
            />
          </label>
          <div className="two">
            <label className="g4-field">
              Gäller från
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="g4-field">
              Till och med
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
          <label className="g4-field">
            Anteckning (valfri)
            <input
              autoComplete="off"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error ? (
            <p role="alert" className="g4-err">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
